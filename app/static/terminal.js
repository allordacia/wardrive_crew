/* WARDRIVE // TERMINAL — operator console renderer.
 *
 * Single canvas-driven scope:
 *   - Radar PPI with rotating sweep, gridlines, range rings
 *   - Detected-BSSID blips that fade after a few sweeps
 *   - SDR-driven spectrum bars across the bottom
 *   - Corner labels (range, sats, scan rate)
 *
 * The page chrome (status pills, metric readouts, radio cards, sniff log,
 * controls) is plain DOM — driven by the same /ws stream.
 *
 * Aesthetic: phosphor-green CRT, scanlines, ASCII frames, monospace
 * everything. Inspired by WarGames / Hackers (1995) / Tron operator
 * consoles. No game elements, no sprites, no characters.
 */
(() => {
  "use strict";

  const W = 640;
  const H = 360;

  // Mirror of app/bt_classify.TRACKER_TAGS — tags that mean "this is a
  // tracker, not just a vendor hint". Drives row-tracker styling and
  // the // TRACKERS HUD line.
  const TRACKER_TAGS = new Set(["airtag", "tile", "smarttag", "chipolo"]);

  const PHOS    = "#b6ffd0";
  const PHOS_DM = "#5fa67a";
  const PHOS_FT = "#244430";
  const AMBER   = "#ffb347";
  const CYAN    = "#5ad8ff";
  const RED     = "#ff4d4d";
  const MAGENTA = "#ff5ad8";
  const BG      = "#0a120e";

  // ----- DOM lookups --------------------------------------------------------
  const cv = document.getElementById("screen");
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  const segNet = document.getElementById("seg-networks");
  const segPkt = document.getElementById("seg-packets");
  const segVel = document.getElementById("seg-speed");
  const statusEl = document.getElementById("status");
  const scopeMeta = document.getElementById("scope-meta");
  const liveMeta  = document.getElementById("live-meta");
  const tbHost    = document.getElementById("tb-host");
  const tbUptime  = document.getElementById("tb-uptime");
  const tbLink    = document.getElementById("tb-link");
  const logEl     = document.getElementById("log");
  const liveTbody = document.getElementById("live-tbody");

  const stat = {
    mon:   document.querySelector('[data-flag="mon"]'),
    pcap:  document.querySelector('[data-flag="pcap"]'),
    gps:   document.querySelector('[data-flag="gps"]'),
    rtc:   document.querySelector('[data-flag="rtc"]'),
    sdr:   document.querySelector('[data-flag="sdr"]'),
    lora:  document.querySelector('[data-flag="lora"]'),
    bt:    document.querySelector('[data-flag="bt"]'),
    warn:  document.querySelector('[data-flag="warn"]'),
  };
  const btTbody = document.getElementById("bt-tbody");

  // ----- snapshot state from /ws -------------------------------------------
  const sim = {
    speed: 0,
    networks: 0,
    packets: 0,
    rf_signals: 0,
    rf_window: 0,
    new_window: 0,
    monitor_on: false,
    pcap_on: false,
    gps_on: false,
    gps_lat: null,
    gps_lon: null,
    gps_sat_count: 0,
    gps_accuracy_m: 0,
    rtc_synced: false,
    sdr_active: false,
    sdr_last_band: "",
    sdr_last_peaks: 0,
    lora_active: false,
    crew_id: "",
    fleet: [],
    status: "connecting...",
    iface: "--",
    visible_nets: [],
    targets_total: 0,
    bt_active: false,
    bt_visible: [],
    bt_devices_total: 0,
    bt_targets_total: 0,
    snapshot: null,
  };
  let prev = JSON.parse(JSON.stringify(sim));

  // ----- radar blip table ---------------------------------------------------
  // Each entry: {a: angle radians, r: 0..1, life: ticks remaining, color}
  // Blips are spawned when a new BSSID is reported (sim.last_scan_new > 0)
  // or when an SDR peak fires.
  const BLIPS = [];
  const BLIP_MAX = 64;

  function spawnBlip(color, mag = 0.7) {
    if (BLIPS.length >= BLIP_MAX) BLIPS.shift();
    BLIPS.push({
      a: Math.random() * Math.PI * 2,
      r: 0.25 + Math.random() * 0.7,
      life: 90 + Math.random() * 60,
      mag,
      color,
    });
  }

  // ----- log lines ----------------------------------------------------------
  const LOG_MAX_LINES = 14;
  const logLines = [];
  function pushLog(kind, text) {
    logLines.push({ kind, text });
    while (logLines.length > LOG_MAX_LINES) logLines.shift();
    renderLog();
  }
  function renderLog() {
    const frag = document.createDocumentFragment();
    for (const l of logLines) {
      const div = document.createElement("div");
      div.className = `ln ln-${l.kind}`;
      div.textContent = l.text;
      frag.appendChild(div);
    }
    logEl.innerHTML = "";
    logEl.appendChild(frag);
  }

  // ----- tick driver --------------------------------------------------------
  let frame = 0;
  let lastTick = performance.now();
  const startTs = Date.now();

  function tickHz() {
    return Math.min(2 + (sim.speed || 0) / 7, 28);
  }

  // ============================================================
  //  scope drawing
  // ============================================================
  function clearScope() {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
  }

  function drawFrame() {
    // Outer dotted border
    ctx.strokeStyle = PHOS_FT;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.strokeRect(4, 4, W - 8, H - 8);
    ctx.setLineDash([]);

    // Corner brackets (ASCII-ish)
    const C = 14;
    ctx.strokeStyle = PHOS_DM;
    ctx.beginPath();
    ctx.moveTo(8, 8 + C); ctx.lineTo(8, 8); ctx.lineTo(8 + C, 8);
    ctx.moveTo(W - 8 - C, 8); ctx.lineTo(W - 8, 8); ctx.lineTo(W - 8, 8 + C);
    ctx.moveTo(8, H - 8 - C); ctx.lineTo(8, H - 8); ctx.lineTo(8 + C, H - 8);
    ctx.moveTo(W - 8 - C, H - 8); ctx.lineTo(W - 8, H - 8); ctx.lineTo(W - 8, H - 8 - C);
    ctx.stroke();
  }

  function drawGrid() {
    ctx.strokeStyle = "rgba(80, 200, 120, 0.07)";
    ctx.lineWidth = 1;
    for (let x = 24; x < W; x += 24) {
      ctx.beginPath(); ctx.moveTo(x, 12); ctx.lineTo(x, H - 60); ctx.stroke();
    }
    for (let y = 24; y < H - 60; y += 24) {
      ctx.beginPath(); ctx.moveTo(12, y); ctx.lineTo(W - 12, y); ctx.stroke();
    }
  }

  function drawRadar(t) {
    // Radar plate centered, leaving room on the right for spectrum legend
    const cx = 220;
    const cy = (H - 60) / 2 + 8;
    const radius = Math.min(140, cy - 20);

    // Concentric rings
    ctx.strokeStyle = PHOS_FT;
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (radius * i) / 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Cross-hairs
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    // Sweep arm — speed scales with capture rate
    const sweepHz = 0.25 + Math.min(2.0, (sim.speed || 0) / 60);
    const sweepA = (t * sweepHz) % (Math.PI * 2);

    // Sweep wedge with fading trail
    for (let i = 0; i < 24; i++) {
      const a0 = sweepA - (i + 1) * 0.04;
      const a1 = sweepA - i * 0.04;
      ctx.fillStyle = `rgba(132, 255, 170, ${(0.18 * (1 - i / 24)).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, a0, a1);
      ctx.closePath();
      ctx.fill();
    }
    // Sweep edge
    ctx.strokeStyle = PHOS;
    ctx.lineWidth = 1.2;
    ctx.shadowColor = PHOS;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(sweepA) * radius, cy + Math.sin(sweepA) * radius);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Center pip
    ctx.fillStyle = PHOS;
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();

    // Blips
    for (let i = BLIPS.length - 1; i >= 0; i--) {
      const b = BLIPS[i];
      b.life--;
      if (b.life <= 0) { BLIPS.splice(i, 1); continue; }
      const fade = Math.min(1, b.life / 100);
      const px = cx + Math.cos(b.a) * radius * b.r;
      const py = cy + Math.sin(b.a) * radius * b.r;
      ctx.fillStyle = b.color;
      ctx.globalAlpha = fade;
      ctx.beginPath();
      ctx.arc(px, py, 2 + b.mag * 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Bearing labels
    ctx.fillStyle = PHOS_DM;
    ctx.font = '11px "VT323", "Courier New", monospace';
    ctx.textBaseline = "top";
    ctx.fillText("000", cx - 10, cy - radius - 14);
    ctx.fillText("180", cx - 10, cy + radius + 4);
    ctx.fillText("270", cx - radius - 26, cy - 6);
    ctx.fillText("090", cx + radius + 4,  cy - 6);

    // Inner readout block (top-left of radar)
    const lines = [
      `RNG  ${pad((BLIPS.length).toString(), 3, " ")} blips`,
      `IFC  ${(sim.iface || "--").slice(0, 8)}`,
      `MON  ${sim.monitor_on ? "ON " : "OFF"}`,
      `SAT  ${pad((sim.gps_sat_count|0).toString(), 2, "0")}`,
      `TGT  ${pad((sim.targets_total|0).toString(), 3, " ")}`,
    ];
    ctx.fillStyle = PHOS_DM;
    lines.forEach((s, i) => ctx.fillText(s, 14, 18 + i * 14));
  }

  function drawSpectrum() {
    // Right-hand spectrum bars (waterfall-ish but live, no history)
    const x0 = 400, y0 = 30;
    const w  = W - x0 - 18;
    const h  = H - 60 - y0 - 8;
    const bars = 28;
    const barW = (w - bars) / bars;

    // Frame
    ctx.strokeStyle = PHOS_FT;
    ctx.strokeRect(x0, y0, w, h);
    ctx.fillStyle = PHOS_DM;
    ctx.font = '11px "VT323", "Courier New", monospace';
    ctx.fillText("// SPEC", x0 + 4, y0 - 12);
    ctx.fillText(sim.sdr_last_band || (sim.sdr_active ? "scanning" : "OFF"), x0 + 60, y0 - 12);

    const intensity = Math.min(1, (sim.rf_window || 0) / 30);
    const peaks = sim.sdr_last_peaks || 0;

    for (let i = 0; i < bars; i++) {
      const seed = ((i * 31) ^ frame ^ (i << 4)) & 0x3f;
      const noise = (seed / 64) * 0.4;
      const peakBoost = (peaks > 0 && (i + (frame >> 2)) % Math.max(2, 8 - peaks) === 0) ? 0.5 : 0;
      const m = sim.sdr_active ? Math.min(1, noise + intensity * 0.7 + peakBoost) : 0;
      const bh = Math.max(2, m * (h - 2));
      const bx = x0 + 1 + i * (barW + 1);
      const by = y0 + h - bh - 1;
      // gradient: green at base, amber at top
      const grd = ctx.createLinearGradient(0, by, 0, by + bh);
      grd.addColorStop(0, AMBER);
      grd.addColorStop(0.4, PHOS);
      grd.addColorStop(1, PHOS_DM);
      ctx.fillStyle = grd;
      ctx.fillRect(bx, by, Math.max(1, barW), bh);
    }

    // Threshold line
    ctx.strokeStyle = "rgba(255,180,80,0.4)";
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x0, y0 + h * 0.35);
    ctx.lineTo(x0 + w, y0 + h * 0.35);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawPacketStream() {
    // Bottom strip — animated hex/byte stream that scrolls with packet rate
    const y = H - 50;
    const h = 40;
    ctx.fillStyle = "rgba(10, 25, 18, 0.9)";
    ctx.fillRect(8, y, W - 16, h);
    ctx.strokeStyle = PHOS_FT;
    ctx.strokeRect(8, y, W - 16, h);

    const speed = Math.max(2, Math.min(12, (sim.speed || 0) / 8 + 2));
    const offset = (frame * speed) | 0;

    ctx.fillStyle = PHOS_DM;
    ctx.font = '12px "VT323", "Courier New", monospace';
    ctx.textBaseline = "top";
    const cols = Math.floor((W - 32) / 8);
    let row1 = "";
    let row2 = "";
    for (let i = 0; i < cols; i++) {
      const v = (((i + offset) * 0x9e3779) ^ (offset >> 3)) & 0xff;
      const v2 = ((((i << 2) + offset * 3) * 0x85ebca) >> 4) & 0xff;
      row1 += v.toString(16).padStart(2, "0").toUpperCase() + " ";
      row2 += v2.toString(16).padStart(2, "0").toUpperCase() + " ";
    }
    ctx.fillText(row1, 14, y + 4);
    ctx.fillStyle = PHOS_FT;
    ctx.fillText(row2, 14, y + 22);

    // pcap-rate indicator
    const rate = (sim.snapshot && sim.snapshot.wifi && sim.snapshot.wifi.pcap_bytes_rate_s) || 0;
    ctx.fillStyle = sim.pcap_on ? PHOS : PHOS_FT;
    ctx.fillText(`PCAP ${fmtRate(rate)}`, W - 130, y + 4);
    ctx.fillStyle = PHOS_DM;
    ctx.fillText(`PKT ${pad(sim.packets, 8)}`, W - 130, y + 22);
  }

  function drawHud() {
    ctx.fillStyle = PHOS_DM;
    ctx.font = '11px "VT323", "Courier New", monospace';
    ctx.textBaseline = "top";
    ctx.fillText(`> SCOPE.SWEEP  ${sim.gps_on ? "GEO=LIVE" : "GEO=NIL"}`, 16, H - 14);

    // // BANDS  2g:N  5g:M  6g:K  ?:U
    const bands = (sim.snapshot && sim.snapshot.bands) || {};
    const segs = [
      `2G:${pad(bands["2g"]|0, 3, " ")}`,
      `5G:${pad(bands["5g"]|0, 3, " ")}`,
      `6G:${pad(bands["6g"]|0, 3, " ")}`,
    ];
    ctx.fillStyle = PHOS_DM;
    ctx.fillText(`// BANDS ${segs.join(" ")}`, 220, H - 14);

    // // TRACKERS — count of in-range tracker categories (airtag/tile/...).
    // Only the visible-now slice counts so the line stays accurate as
    // adverts fade out of range, not the historical total.
    const visTrackers = (sim.bt_visible || []).filter(d => TRACKER_TAGS.has(d.tracker_type));
    if (visTrackers.length > 0) {
      const counts = {};
      for (const d of visTrackers) counts[d.tracker_type] = (counts[d.tracker_type] || 0) + 1;
      const segs2 = Object.entries(counts).map(([t, n]) => `${t.toUpperCase()}:${n}`);
      ctx.fillStyle = AMBER;
      ctx.fillText(`// TRACKERS ${segs2.join(" ")}`, 16, H - 28);
    }

    ctx.fillStyle = sim.lora_active ? MAGENTA : PHOS_FT;
    ctx.fillText(`MESH=${(sim.fleet || []).length}`, W - 86, H - 14);
  }

  // ============================================================
  //  fmt helpers
  // ============================================================
  function pad(n, w, c) {
    return String(n).padStart(w, c == null ? "0" : c);
  }
  function fmtAge(s) {
    if (s === null || s === undefined) return "--";
    if (s < 1) return "now";
    if (s < 60) return `${Math.round(s)}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
  }
  function fmtRate(bps) {
    if (!bps) return "0 B/s";
    if (bps < 1024) return `${Math.round(bps)} B/s`;
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KiB/s`;
    return `${(bps / 1024 / 1024).toFixed(1)} MiB/s`;
  }
  function fmtCoord(lat, lon) {
    if (lat == null || lon == null) return "no fix";
    return `${lat.toFixed(4)},${lon.toFixed(4)}`;
  }
  function fmtUptime(ms) {
    const s = (ms / 1000) | 0;
    const hh = pad((s / 3600) | 0, 2);
    const mm = pad(((s / 60) | 0) % 60, 2);
    const ss = pad(s % 60, 2);
    return `T+${hh}:${mm}:${ss}`;
  }

  // ============================================================
  //  reactions to snapshot diffs — spawn blips, push log lines
  // ============================================================
  function reactToSnapshot(s) {
    const newCount = (s.wifi && s.wifi.last_scan_new) || 0;
    if (newCount > 0 && newCount !== ((prev.snapshot && prev.snapshot.wifi
                                       && prev.snapshot.wifi.last_scan_new) || -1)) {
      for (let i = 0; i < Math.min(8, newCount); i++) spawnBlip(PHOS, 1);
      pushLog("new", `+ ${pad(newCount, 2, " ")} new bssid${newCount > 1 ? "s" : ""}  total=${pad(s.networks_total||0, 6, " ")}`);
    }

    const peaks = (s.sdr && s.sdr.last_peaks) || 0;
    const prevPeaks = (prev.snapshot && prev.snapshot.sdr && prev.snapshot.sdr.last_peaks) || 0;
    if (peaks > 0 && peaks !== prevPeaks) {
      for (let i = 0; i < Math.min(6, peaks); i++) spawnBlip(CYAN, 1.2);
      pushLog("rf", `~ ${(s.sdr && s.sdr.last_band) || "?"} peaks=${peaks}  total=${s.rf_signals_total || 0}`);
    }

    const txCount = (s.lora && s.lora.tx_count) || 0;
    const rxCount = (s.lora && s.lora.rx_count) || 0;
    const prevTx  = (prev.snapshot && prev.snapshot.lora && prev.snapshot.lora.tx_count) || 0;
    const prevRx  = (prev.snapshot && prev.snapshot.lora && prev.snapshot.lora.rx_count) || 0;
    if (txCount > prevTx) {
      pushLog("lora", `> mesh tx  ${s.crew_id || "?"} score=${s.networks_total || 0}`);
    }
    if (rxCount > prevRx) {
      spawnBlip(MAGENTA, 1.4);
      pushLog("lora", `< mesh rx  fleet=${(s.fleet || []).length}`);
    }

    if (s.monitor_on && !(prev.snapshot && prev.snapshot.monitor_on)) {
      pushLog("sys", `! monitor mode engaged  iface=${s.monitor_iface || s.iface}`);
    }
    if (!s.monitor_on && prev.snapshot && prev.snapshot.monitor_on) {
      pushLog("warn", `! monitor mode disengaged`);
    }
    if (s.gps && s.gps.have_fix && !(prev.snapshot && prev.snapshot.gps && prev.snapshot.gps.have_fix)) {
      pushLog("sys", `! gps fix acquired  ${fmtCoord(s.gps.lat, s.gps.lon)}`);
    }
    if (s.rtc_synced && !(prev.snapshot && prev.snapshot.rtc_synced)) {
      pushLog("sys", `! rtc synced  ${s.rtc && s.rtc.device || "/dev/rtc0"}`);
    }

    // Targets in range — surface as red blips and a ticker line so the
    // operator notices when a tracked BSSID re-enters range.
    const visTargets = (s.visible_nets || []).filter(n => n.targeted);
    const prevTargBssids = new Set(
      ((prev.snapshot && prev.snapshot.visible_nets) || [])
        .filter(n => n.targeted).map(n => n.bssid)
    );
    for (const n of visTargets) {
      if (!prevTargBssids.has(n.bssid)) {
        spawnBlip(RED, 1.4);
        pushLog("tgt", `! target in range  ${(n.ssid || "(hidden)")}  ${n.bssid}`);
      }
    }

    // BT — newly-heard BLE devices register as cyan blips on the radar;
    // targeted BLE devices coming in range pulse red like wifi targets.
    const btNew = (s.bt && s.bt.last_scan_new) || 0;
    const prevBtNew = (prev.snapshot && prev.snapshot.bt && prev.snapshot.bt.last_scan_new) || -1;
    if (btNew > 0 && btNew !== prevBtNew) {
      for (let i = 0; i < Math.min(6, btNew); i++) spawnBlip(CYAN, 0.9);
      pushLog("rf", `~ +${btNew} new BLE device${btNew > 1 ? "s" : ""}`);
    }
    const visBtTargets = (s.bt_visible || []).filter(d => d.targeted);
    const prevBtTargMacs = new Set(
      ((prev.snapshot && prev.snapshot.bt_visible) || [])
        .filter(d => d.targeted).map(d => d.mac)
    );
    for (const d of visBtTargets) {
      if (!prevBtTargMacs.has(d.mac)) {
        spawnBlip(RED, 1.3);
        pushLog("tgt", `! BT target in range  ${d.name || "(anon)"}  ${(d.mac||"").toUpperCase()}`);
      }
    }
  }

  // ============================================================
  //  DOM-side updaters
  // ============================================================
  const radioCards = {};
  document.querySelectorAll(".radio-card").forEach(el => {
    const id = el.dataset.radio;
    radioCards[id] = {
      root: el,
      state: el.querySelector(".rc-state"),
      lines: el.querySelectorAll(".rc-line"),
    };
  });
  function setCard(id, on, state, lines) {
    const card = radioCards[id];
    if (!card) return;
    card.root.dataset.on = on;
    card.state.textContent = state;
    for (let i = 0; i < card.lines.length; i++) {
      card.lines[i].textContent = lines[i] || "--";
    }
  }

  function updateChrome() {
    segNet.textContent = pad(sim.networks, 6);
    segPkt.textContent = pad(sim.packets, 8);
    segVel.textContent = pad(Math.round(sim.speed), 3);
    statusEl.textContent = `> ${sim.status || "ok"}`;

    stat.mon.dataset.active  = sim.monitor_on ? "1" : "0";
    stat.pcap.dataset.active = sim.pcap_on ? "1" : "0";
    stat.gps.dataset.active  = sim.gps_on ? "1" : "0";
    stat.rtc.dataset.active  = sim.rtc_synced ? "1" : "0";
    stat.sdr.dataset.active  = sim.sdr_active ? "1" : "0";
    stat.lora.dataset.active = sim.lora_active ? "1" : "0";
    if (stat.bt) stat.bt.dataset.active = sim.bt_active ? "1" : "0";
    stat.warn.dataset.active = (sim.speed > 180 || (sim.snapshot && sim.snapshot.status && /fail|error/i.test(sim.snapshot.status))) ? "1" : "0";

    btnMon.dataset.on = sim.monitor_on ? "1" : "0";
    btnMon.textContent = `[F1] MONITOR: ${sim.monitor_on ? "ON" : "OFF"}`;

    tbHost.textContent   = `HOST: ${sim.iface || "--"}`;
    tbUptime.textContent = fmtUptime(Date.now() - startTs);
    tbLink.textContent   = `LINK: ${sim.snapshot ? "OK" : "...waiting"}`;

    scopeMeta.textContent = `${BLIPS.length} blip${BLIPS.length === 1 ? "" : "s"} :: sweep ${tickHz().toFixed(1)}hz`;
    if (liveMeta) {
      const vNets = (sim.visible_nets || []).length;
      const vBt   = (sim.bt_visible || []).length;
      liveMeta.textContent =
        `nets ${vNets}/${sim.targets_total || 0}t :: bt ${vBt}/${sim.bt_targets_total || 0}t`;
    }
  }

  // ============================================================
  //  LIVE.NETS table — visible BSSIDs with click-to-flag actions
  // ============================================================
  const liveSeen = new Set();

  function updateLiveNets() {
    const nets = sim.visible_nets || [];
    if (!liveTbody) return;
    if (nets.length === 0) {
      liveTbody.innerHTML = '<tr class="empty"><td colspan="7">// no networks in range</td></tr>';
      return;
    }
    const frag = document.createDocumentFragment();
    const nowSec = Date.now() / 1000;
    for (const n of nets) {
      const tr = document.createElement("tr");
      tr.dataset.bssid = n.bssid;
      if (n.whitelisted) tr.classList.add("row-wl");
      if (n.targeted)    tr.classList.add("row-tg");
      if (!liveSeen.has(n.bssid)) {
        tr.classList.add("fresh");
        liveSeen.add(n.bssid);
      }
      const sigTxt = (n.signal != null) ? `${n.signal} dBm` : "--";
      const ageS = n.last_seen ? Math.max(0, nowSec - n.last_seen) : null;
      const ageTxt = ageS == null ? "--"
        : ageS < 60 ? `${Math.round(ageS)}s`
        : ageS < 3600 ? `${Math.round(ageS / 60)}m`
        : `${Math.round(ageS / 3600)}h`;

      const ssidShort = (n.ssid || "(hidden)");
      const bssidShort = (n.bssid || "").slice(-8);
      tr.innerHTML =
        `<td class="c-act">` +
          `<button class="flag-btn" data-kind="wl" data-on="${n.whitelisted ? 1 : 0}" title="whitelist (excludes from score)">[*]</button>` +
          `<button class="flag-btn" data-kind="tg" data-on="${n.targeted    ? 1 : 0}" title="add to target list">[!]</button>` +
        `</td>` +
        `<td class="c-ssid">${escapeHtml(ssidShort)}</td>` +
        `<td class="c-bssid" title="${escapeHtml(n.bssid || "")}">${escapeHtml(bssidShort)}</td>` +
        `<td class="c-ch">${n.channel ?? "-"}</td>` +
        `<td class="c-sig">${sigTxt}</td>` +
        `<td class="c-enc">${escapeHtml(n.encryption || "-")}</td>` +
        `<td class="c-age">${ageTxt}</td>`;
      frag.appendChild(tr);
    }
    liveTbody.replaceChildren(frag);
  }

  // Generic flag-toggle: updates row optimistically, rolls back on failure.
  // `endpoint(id)` builds the PUT URL; `idAttr` is the row's data attribute
  // that holds the resource id (bssid / mac).
  function bindFlagToggles(tbody, endpoint, idAttr, label) {
    if (!tbody) return;
    tbody.addEventListener("click", async (ev) => {
      const btn = ev.target.closest(".flag-btn");
      if (!btn) return;
      const tr = btn.closest("tr");
      const id = tr && tr.dataset[idAttr];
      if (!id) return;
      const kind = btn.dataset.kind;
      const next = btn.dataset.on === "1" ? 0 : 1;
      const prevOn = btn.dataset.on;
      btn.dataset.on = String(next);
      if (kind === "wl") tr.classList.toggle("row-wl", next === 1);
      if (kind === "tg") tr.classList.toggle("row-tg", next === 1);
      try {
        const body = kind === "wl"
          ? { whitelisted: next === 1 }
          : { targeted:    next === 1 };
        const r = await fetch(endpoint(id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
        const tag = kind === "wl" ? "whitelist" : "target";
        const verb = next === 1 ? "+" : "-";
        pushLog(kind === "tg" ? "tgt" : "sys",
                `${verb} ${label} ${tag}  ${id}`);
      } catch (e) {
        btn.dataset.on = prevOn;
        if (kind === "wl") tr.classList.toggle("row-wl", prevOn === "1");
        if (kind === "tg") tr.classList.toggle("row-tg", prevOn === "1");
        pushLog("warn", `! flag toggle failed: ${e}`);
      }
    });
  }

  bindFlagToggles(liveTbody,
                  (id) => `/api/network/${encodeURIComponent(id)}`,
                  "bssid", "net");
  bindFlagToggles(btTbody,
                  (id) => `/api/bt/${encodeURIComponent(id)}`,
                  "mac", "bt");

  // ============================================================
  //  BT.DEVICES table — visible BLE devices
  // ============================================================
  const btSeen = new Set();
  function updateBtDevices() {
    if (!btTbody) return;
    const devs = sim.bt_visible || [];
    if (devs.length === 0) {
      btTbody.innerHTML = '<tr class="empty"><td colspan="6">// no BLE devices in range</td></tr>';
      return;
    }
    const frag = document.createDocumentFragment();
    const nowSec = Date.now() / 1000;
    for (const d of devs) {
      const tr = document.createElement("tr");
      tr.dataset.mac = d.mac;
      if (d.whitelisted) tr.classList.add("row-wl");
      if (d.targeted)    tr.classList.add("row-tg");
      if (!btSeen.has(d.mac)) { tr.classList.add("fresh"); btSeen.add(d.mac); }
      const rssiTxt = (d.rssi != null) ? `${d.rssi} dBm` : "--";
      const ageS = d.last_seen ? Math.max(0, nowSec - d.last_seen) : null;
      const ageTxt = ageS == null ? "--"
        : ageS < 60 ? `${Math.round(ageS)}s`
        : ageS < 3600 ? `${Math.round(ageS / 60)}m`
        : `${Math.round(ageS / 3600)}h`;
      const macShort = (d.mac || "").toUpperCase();
      const nameTxt = d.name || "(anon)";
      // Tracker / beacon classifier tag — render as a coloured chip next
      // to the manufacturer column. Trackers (airtag/tile/smarttag) get
      // an extra row class so the whole line jumps out.
      const tag = d.tracker_type || "";
      const tagChip = tag ? `<span class="bt-tag bt-tag-${tag}">${escapeHtml(tag.toUpperCase())}</span>` : "";
      if (TRACKER_TAGS.has(tag)) tr.classList.add("row-tracker");
      tr.innerHTML =
        `<td class="c-act">` +
          `<button class="flag-btn" data-kind="wl" data-on="${d.whitelisted ? 1 : 0}" title="whitelist">[*]</button>` +
          `<button class="flag-btn" data-kind="tg" data-on="${d.targeted    ? 1 : 0}" title="add to target list">[!]</button>` +
        `</td>` +
        `<td class="c-ssid">${tagChip}${escapeHtml(nameTxt)}</td>` +
        `<td class="c-bssid">${escapeHtml(macShort)}</td>` +
        `<td class="c-sig">${rssiTxt}</td>` +
        `<td class="c-enc">${escapeHtml(d.manufacturer || "-")}</td>` +
        `<td class="c-age">${ageTxt}</td>`;
      frag.appendChild(tr);
    }
    btTbody.replaceChildren(frag);
  }

  // ============================================================
  //  Tab switching for the live panel
  // ============================================================
  document.querySelectorAll(".panel-tabs .tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const id = tab.dataset.tab;
      document.querySelectorAll(".panel-tabs .tab")
        .forEach(t => t.classList.toggle("active", t === tab));
      document.querySelectorAll('[data-tab-pane]').forEach(p => {
        p.hidden = p.dataset.tabPane !== id;
      });
    });
  });

  function updateRadioPanel(s) {
    if (!s) return;

    // WIFI
    const w = s.wifi || {};
    if (w.monitor_on) {
      setCard("wifi", "1", w.pcap_on ? "MONITOR+PCAP" : "MONITOR", [
        `${w.monitor_iface || w.iface} :: ${fmtRate(w.pcap_bytes_rate_s)}`,
        `${s.networks_total} bssid :: ${s.packets_total} pkt`,
      ]);
    } else {
      const on = w.last_scan_age_s !== null && w.last_scan_age_s < 30;
      setCard("wifi", on ? "1" : "0", on ? "SCANNING" : "IDLE", [
        `${w.iface} :: scan ${fmtAge(w.last_scan_age_s)}`,
        `+${w.last_scan_new || 0} new / ${w.last_scan_seen || 0} seen`,
      ]);
    }

    // GPS
    const g = s.gps || {};
    if (g.have_fix) {
      const acc = g.accuracy_m ? ` +/-${Math.round(g.accuracy_m)}m` : "";
      const sats = g.sat_count ? ` :: ${g.sat_count} sat` : "";
      const src = g.source === "serial" ? "SERIAL" : g.source === "browser" ? "BROWSER" : "ON";
      setCard("gps", "1", src, [
        `${fmtCoord(g.lat, g.lon)}${acc}`,
        `${(g.speed_mps * 2.237).toFixed(1)} mph${sats} :: ${fmtAge(g.age_s)}`,
      ]);
    } else {
      // Distinguish "no NMEA flowing" from "NMEA flowing but no fix yet"
      // so the operator can tell whether the GPS module is alive.
      const frames = g.nmea_frames || 0;
      const fresh  = g.nmea_age_s != null && g.nmea_age_s < 5;
      const tracked = g.sats_tracked || 0;
      if (fresh) {
        // NMEA hot off the wire — tracking sats but no fix yet.
        setCard("gps", "warn", tracked > 0 ? "NMEA / NO FIX" : "NMEA / 0 SAT", [
          tracked > 0
            ? `${tracked} sat tracked :: ${frames} nmea frames`
            : `nmea ok, antenna sees no sats yet`,
          tracked > 0
            ? `cold start: 30-300s outdoors w/ clear sky`
            : `check antenna cable / move outdoors`,
        ]);
      } else if (frames > 0) {
        // We've heard NMEA at some point but it stopped.
        setCard("gps", "warn", "NMEA STALE", [
          `last frame ${fmtAge(g.nmea_age_s)} ago`,
          `gps rail dropped? check aio_ctl gps on`,
        ]);
      } else {
        setCard("gps", "0", "NO NMEA", [
          "no data on GPS UART",
          "check WARDRIVE_GPS_DEVICE / aio_ctl gps on",
        ]);
      }
    }

    // RTC
    const r = s.rtc || {};
    if (r.synced) {
      setCard("rtc", "1", "SYNCED", [r.device || "/dev/rtc0", `synced ${fmtAge(r.synced_age_s)}`]);
    } else {
      setCard("rtc", "0", "OFF", ["no hardware clock", "set WARDRIVE_RTC_SYNC=1"]);
    }

    // SDR
    const d = s.sdr || {};
    if (d.active) {
      setCard("sdr", "1", d.last_peaks > 0 ? "ACTIVE" : "SWEEPING", [
        `${d.last_band || "--"} :: ${d.last_peaks || 0} peak`,
        `${d.bands_count} band :: ${s.rf_signals_total} tot :: ${fmtAge(d.last_age_s)}`,
      ]);
    } else {
      setCard("sdr", "0", "OFF", ["no SDR sweep running", "set WARDRIVE_SDR_ENABLED=1"]);
    }

    // LORA
    const l = s.lora || {};
    if (l.active) {
      setCard("lora", "1", "MESH", [
        `${s.crew_id || "?"} :: ${(s.fleet || []).length} fleet`,
        `tx ${l.tx_count}/${fmtAge(l.tx_age_s)} rx ${l.rx_count}/${fmtAge(l.rx_age_s)}`,
      ]);
    } else {
      setCard("lora", "0", "OFF", ["no Meshtastic node", "set WARDRIVE_LORA_DEVICE=..."]);
    }

    // BT (BLE)
    const bt = s.bt || {};
    if (bt.active) {
      setCard("bt", "1", "BLE SCAN", [
        `${bt.adapter || "hci0"} :: ${bt.devices_total || 0} dev :: ${bt.targets_total || 0} tgt`,
        `+${bt.last_scan_new || 0} new / ${bt.last_scan_seen || 0} live :: ${fmtAge(bt.last_scan_age_s)}`,
      ]);
    } else {
      setCard("bt", "0", "OFF", ["no BLE scanner running", "set WARDRIVE_BT_ENABLED=1"]);
    }
  }

  // ============================================================
  //  websocket
  // ============================================================
  let _ws = null;
  let _wsReconnectTimer = null;
  function connectWs() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    _ws = new WebSocket(url);
    _ws.onmessage = (ev) => {
      try {
        const s = JSON.parse(ev.data);
        sim.speed = s.speed_mph || 0;
        sim.networks = s.networks_total || 0;
        sim.packets = s.packets_total || 0;
        sim.rf_signals = s.rf_signals_total || 0;
        sim.rf_window = s.rf_window || 0;
        sim.new_window = s.new_window || 0;
        sim.monitor_on = !!s.monitor_on;
        sim.pcap_on = !!s.pcap_on;
        sim.gps_on = !!(s.gps && s.gps.have_fix);
        sim.gps_lat = (s.gps && s.gps.lat) || null;
        sim.gps_lon = (s.gps && s.gps.lon) || null;
        sim.gps_sat_count = (s.gps && s.gps.sat_count) || 0;
        sim.gps_accuracy_m = (s.gps && s.gps.accuracy_m) || 0;
        sim.rtc_synced = !!s.rtc_synced;
        sim.sdr_active = !!s.sdr_active;
        sim.sdr_last_band = (s.sdr && s.sdr.last_band) || "";
        sim.sdr_last_peaks = (s.sdr && s.sdr.last_peaks) || 0;
        sim.lora_active = !!s.lora_active;
        sim.crew_id = s.crew_id || "";
        sim.fleet = Array.isArray(s.fleet) ? s.fleet : [];
        sim.status = s.status || "";
        sim.iface = s.iface || sim.iface;
        sim.visible_nets = Array.isArray(s.visible_nets) ? s.visible_nets : [];
        sim.targets_total = s.targets_total || 0;
        sim.bt_active = !!s.bt_active;
        sim.bt_visible = Array.isArray(s.bt_visible) ? s.bt_visible : [];
        sim.bt_devices_total = s.bt_devices_total || 0;
        sim.bt_targets_total = s.bt_targets_total || 0;
        sim.snapshot = s;

        reactToSnapshot(s);
        prev.snapshot = s;

        updateChrome();
        updateRadioPanel(s);
        updateLiveNets();
        updateBtDevices();
      } catch (e) { /* ignore */ }
    };
    _ws.onclose = () => {
      sim.status = "link down";
      updateChrome();
      _wsReconnectTimer = setTimeout(connectWs, 1500);
    };
    _ws.onerror = () => { try { _ws.close(); } catch (e) {} };
  }

  // ============================================================
  //  monitor button
  // ============================================================
  const btnMon = document.getElementById("btn-monitor");
  btnMon.addEventListener("click", async () => {
    btnMon.disabled = true;
    btnMon.dataset.err = "0";
    try {
      const path = sim.monitor_on ? "/api/monitor/off" : "/api/monitor/on";
      const r = await fetch(path, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || "monitor toggle failed");
      sim.monitor_on = !!j.monitor_on;
      sim.pcap_on = !!j.pcap_on;
      updateChrome();
    } catch (e) {
      btnMon.dataset.err = "1";
      statusEl.textContent = `> ! ${e}`;
      pushLog("warn", `! ${e}`);
    } finally {
      btnMon.disabled = false;
    }
  });

  // ============================================================
  //  GPS button — host browser geolocation
  // ============================================================
  const btnGps = document.getElementById("btn-gps");
  let gpsWatch = null;
  function gpsErrLabel(err) {
    if (err.code === 1) return "DENIED";
    if (err.code === 2) return "NO FIX";
    if (err.code === 3) return "TIMEOUT";
    return "ERR";
  }
  btnGps.addEventListener("click", () => {
    if (!("geolocation" in navigator)) {
      btnGps.dataset.err = "1";
      btnGps.textContent = "[F2] GPS: UNAVAIL";
      return;
    }
    if (!window.isSecureContext) {
      btnGps.dataset.err = "1";
      btnGps.textContent = "[F2] GPS: HTTPS REQ";
      statusEl.textContent = "> ! geolocation needs https. use https://<host>:8443/";
      return;
    }
    if (gpsWatch !== null) {
      navigator.geolocation.clearWatch(gpsWatch);
      gpsWatch = null;
      btnGps.dataset.on = "0";
      btnGps.textContent = "[F2] GPS: OFF";
      return;
    }
    btnGps.textContent = "[F2] GPS: WAIT...";
    gpsWatch = navigator.geolocation.watchPosition(
      (pos) => {
        btnGps.dataset.on = "1";
        btnGps.dataset.err = "0";
        btnGps.textContent = "[F2] GPS: ON";
        const c = pos.coords;
        fetch("/api/gps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lat: c.latitude,
            lon: c.longitude,
            speed_mps: c.speed != null ? c.speed : 0,
            accuracy_m: c.accuracy || 0,
          }),
        }).catch(() => {});
      },
      (err) => {
        btnGps.dataset.err = "1";
        btnGps.textContent = `[F2] GPS: ${gpsErrLabel(err)}`;
        statusEl.textContent = `> ! gps: ${err.message || err.code}`;
        gpsWatch = null;
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  });

  // ============================================================
  //  CONFIG / whitelist modal
  // ============================================================
  const modal = document.getElementById("settings");
  const btnSettings = document.getElementById("btn-settings");
  const btnCloseSettings = document.getElementById("btn-close-settings");
  const btnRefresh = document.getElementById("btn-refresh");
  const btnSaveWl = document.getElementById("btn-save-wl");
  const filterEl = document.getElementById("filter");
  const tbody = document.getElementById("net-tbody");
  const wlCount = document.getElementById("wl-count");

  let netCache = [];
  let pendingWl = new Set();

  async function loadNetworks() {
    const r = await fetch("/api/networks?limit=2000");
    if (!r.ok) return;
    netCache = await r.json();
    pendingWl = new Set(netCache.filter(n => n.whitelisted).map(n => n.bssid));
    renderNetworks();
  }
  function renderNetworks() {
    const q = (filterEl.value || "").trim().toLowerCase();
    const rows = netCache
      .filter(n => !q
        || (n.ssid || "").toLowerCase().includes(q)
        || (n.bssid || "").toLowerCase().includes(q))
      .sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
    tbody.innerHTML = "";
    const frag = document.createDocumentFragment();
    rows.forEach(n => {
      const tr = document.createElement("tr");
      const wl = pendingWl.has(n.bssid);
      if (wl) tr.classList.add("wl");
      tr.innerHTML =
        `<td><input type="checkbox" data-bssid="${n.bssid}" ${wl ? "checked" : ""}></td>` +
        `<td>${escapeHtml(n.ssid || "(hidden)")}</td>` +
        `<td class="bssid">${n.bssid}</td>` +
        `<td>${n.channel ?? "-"}</td>` +
        `<td class="sig">${n.signal != null ? n.signal + " dBm" : "-"}</td>` +
        `<td>${n.encryption || "-"}</td>` +
        `<td>${formatAge(n.last_seen)}</td>`;
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
    wlCount.textContent = `${pendingWl.size} whitelisted`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function formatAge(ts) {
    if (!ts) return "-";
    const dt = (Date.now() / 1000) - ts;
    if (dt < 60) return `${Math.round(dt)}s`;
    if (dt < 3600) return `${Math.round(dt / 60)}m`;
    return `${Math.round(dt / 3600)}h`;
  }
  tbody.addEventListener("change", (ev) => {
    const cb = ev.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const bssid = cb.dataset.bssid;
    if (cb.checked) pendingWl.add(bssid); else pendingWl.delete(bssid);
    cb.closest("tr").classList.toggle("wl", cb.checked);
    wlCount.textContent = `${pendingWl.size} whitelisted`;
  });
  filterEl.addEventListener("input", renderNetworks);
  btnRefresh.addEventListener("click", loadNetworks);
  btnSaveWl.addEventListener("click", async () => {
    btnSaveWl.disabled = true;
    try {
      const r = await fetch("/api/whitelist", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bssids: Array.from(pendingWl), ssids: [] }),
      });
      const j = await r.json();
      statusEl.textContent = `> whitelist saved (${j.whitelisted_count})`;
      pushLog("sys", `! whitelist saved  count=${j.whitelisted_count}`);
      await loadNetworks();
    } catch (e) {
      statusEl.textContent = `> ! save failed: ${e}`;
    } finally {
      btnSaveWl.disabled = false;
    }
  });

  // ============================================================
  //  Wifi interface picker (CONFIG modal)
  // ============================================================
  const ifaceSelect = document.getElementById("iface-select");
  const ifaceInfo   = document.getElementById("iface-info");
  const btnIfaceRefresh = document.getElementById("btn-iface-refresh");

  async function loadIfaces() {
    if (!ifaceSelect) return;
    let data;
    try {
      const r = await fetch("/api/iface");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = await r.json();
    } catch (e) {
      if (ifaceInfo) ifaceInfo.textContent = `! load failed: ${e}`;
      return;
    }
    const ifs = data.interfaces || [];
    ifaceSelect.innerHTML = "";
    if (ifs.length === 0) {
      const opt = document.createElement("option");
      opt.value = data.current || "";
      opt.textContent = (data.current || "--") + " (none detected)";
      ifaceSelect.appendChild(opt);
    } else {
      for (const i of ifs) {
        const opt = document.createElement("option");
        opt.value = i.name;
        opt.textContent = `${i.name}  [${i.operstate || "?"}]`;
        if (i.name === data.current) opt.selected = true;
        ifaceSelect.appendChild(opt);
      }
      // Surface a saved selection that no longer matches present hardware.
      if (data.current && !ifs.some(i => i.name === data.current)) {
        const opt = document.createElement("option");
        opt.value = data.current;
        opt.textContent = `${data.current}  [missing]`;
        opt.selected = true;
        ifaceSelect.appendChild(opt);
      }
    }
    if (ifaceInfo) {
      ifaceInfo.textContent = data.current
        ? (data.current_present ? `current: ${data.current}`
                                : `! current ${data.current} not present`)
        : "no interface selected";
    }
  }

  if (ifaceSelect) {
    ifaceSelect.addEventListener("change", async () => {
      const next = ifaceSelect.value;
      if (ifaceInfo) ifaceInfo.textContent = `switching to ${next}...`;
      try {
        const r = await fetch("/api/iface", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ iface: next }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
        if (ifaceInfo) ifaceInfo.textContent = `current: ${j.iface}`;
        statusEl.textContent = `> iface = ${j.iface}`;
        pushLog("sys", `! iface switched -> ${j.iface}`);
      } catch (e) {
        if (ifaceInfo) ifaceInfo.textContent = `! ${e}`;
        pushLog("warn", `! iface switch failed: ${e}`);
        await loadIfaces();
      }
    });
  }
  if (btnIfaceRefresh) btnIfaceRefresh.addEventListener("click", loadIfaces);

  btnSettings.addEventListener("click", async () => {
    modal.hidden = false;
    await Promise.all([loadIfaces(), loadNetworks()]);
  });
  btnCloseSettings.addEventListener("click", () => { modal.hidden = true; });
  modal.addEventListener("click", (ev) => {
    if (ev.target === modal) modal.hidden = true;
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !modal.hidden) modal.hidden = true;
  });

  // ============================================================
  //  main loop
  // ============================================================
  function render(now) {
    const t = now / 1000;
    clearScope();
    drawGrid();
    drawSpectrum();
    drawRadar(t);
    drawPacketStream();
    drawHud();
    drawFrame();
  }

  function loop(now) {
    const dtMs = 1000 / tickHz();
    if (now - lastTick >= dtMs) {
      frame = (frame + 1) | 0;
      lastTick = now;
    }
    render(now);
    updateChrome();
    requestAnimationFrame(loop);
  }

  // boot
  pushLog("sys", `! wardrive//terminal online`);
  pushLog("sys", `! awaiting telemetry...`);
  updateChrome();
  connectWs();
  requestAnimationFrame(loop);
})();
