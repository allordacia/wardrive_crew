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
    mon:    document.querySelector('[data-flag="mon"]'),
    pcap:   document.querySelector('[data-flag="pcap"]'),
    gps:    document.querySelector('[data-flag="gps"]'),
    rtc:    document.querySelector('[data-flag="rtc"]'),
    sdr:    document.querySelector('[data-flag="sdr"]'),
    lora:   document.querySelector('[data-flag="lora"]'),
    bt:     document.querySelector('[data-flag="bt"]'),
    mission: document.querySelector('[data-flag="mission"]'),
    warn:   document.querySelector('[data-flag="warn"]'),
  };
  const btTbody = document.getElementById("bt-tbody");
  const rfTbody = document.getElementById("rf-tbody");
  const clientsTbody = document.getElementById("clients-tbody");

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
    rtl433_active: false,
    rf_visible: [],
    rf_devices_total: 0,
    rf_targets_total: 0,
    wifi_clients_active: false,
    wifi_clients_visible: [],
    wifi_clients_total: 0,
    wifi_client_targets_total: 0,
    mission: { status: "idle", id: null, started_at: null, summary: null },
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
    if (stat.mission) {
      const ms = (sim.mission && sim.mission.status) || "idle";
      stat.mission.textContent = `[ MISSION:${ms.toUpperCase()} ]`;
      stat.mission.dataset.active = ms === "active" || ms === "debriefing" ? "1" : "0";
    }
    stat.warn.dataset.active = (sim.speed > 180 || (sim.snapshot && sim.snapshot.status && /fail|error/i.test(sim.snapshot.status))) ? "1" : "0";

    btnMon.dataset.on = sim.monitor_on ? "1" : "0";
    btnMon.textContent = `[F1] MONITOR: ${sim.monitor_on ? "ON" : "OFF"}`;

    tbHost.textContent   = `HOST: ${sim.iface || "--"}`;
    tbUptime.textContent = fmtUptime(Date.now() - startTs);
    tbLink.textContent   = `LINK: ${sim.snapshot ? "OK" : "...waiting"}`;

    scopeMeta.textContent = `${BLIPS.length} blip${BLIPS.length === 1 ? "" : "s"} :: sweep ${tickHz().toFixed(1)}hz`;
    if (liveMeta) {
      const vNets    = (sim.visible_nets || []).length;
      const vClients = (sim.wifi_clients_visible || []).length;
      const vBt      = (sim.bt_visible || []).length;
      const vRf      = (sim.rf_visible || []).length;
      liveMeta.textContent =
        `nets ${vNets}/${sim.targets_total || 0}t :: ` +
        `sta ${vClients}/${sim.wifi_client_targets_total || 0}t :: ` +
        `bt ${vBt}/${sim.bt_targets_total || 0}t :: ` +
        `rf ${vRf}/${sim.rf_targets_total || 0}t`;
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
  //  RF.DEVICES table — rtl_433 consumer-device decodes
  // ============================================================
  const rfSeen = new Set();
  function updateRfDevices() {
    if (!rfTbody) return;
    const devs = sim.rf_visible || [];
    if (devs.length === 0) {
      const placeholder = sim.rtl433_active
        ? "// rtl_433 listening, no decodes yet"
        : "// rtl_433 disabled (set WARDRIVE_RTL433_ENABLED=1)";
      rfTbody.innerHTML = `<tr class="empty"><td colspan="7">${placeholder}</td></tr>`;
      return;
    }
    const frag = document.createDocumentFragment();
    const nowSec = Date.now() / 1000;
    for (const d of devs) {
      const tr = document.createElement("tr");
      tr.dataset.rfkey = d.key;
      if (d.whitelisted) tr.classList.add("row-wl");
      if (d.targeted)    tr.classList.add("row-tg");
      if (!rfSeen.has(d.key)) { tr.classList.add("fresh"); rfSeen.add(d.key); }
      const rssiTxt = (d.rssi != null) ? `${d.rssi} dBm` : "--";
      const freqTxt = d.freq_mhz ? `${d.freq_mhz.toFixed(2)} MHz` : "--";
      const ageS = d.last_seen ? Math.max(0, nowSec - d.last_seen) : null;
      const ageTxt = ageS == null ? "--"
        : ageS < 60 ? `${Math.round(ageS)}s`
        : ageS < 3600 ? `${Math.round(ageS / 60)}m`
        : `${Math.round(ageS / 3600)}h`;
      const idTxt = d.dev_id || (d.channel ? `ch${d.channel}` : "-");
      tr.innerHTML =
        `<td class="c-act">` +
          `<button class="flag-btn" data-kind="wl" data-on="${d.whitelisted ? 1 : 0}" title="whitelist">[*]</button>` +
          `<button class="flag-btn" data-kind="tg" data-on="${d.targeted    ? 1 : 0}" title="add to target list">[!]</button>` +
        `</td>` +
        `<td class="c-ssid">${escapeHtml(d.model || "?")}</td>` +
        `<td class="c-bssid">${escapeHtml(idTxt)}</td>` +
        `<td class="c-sig">${rssiTxt}</td>` +
        `<td class="c-enc">${escapeHtml(freqTxt)}</td>` +
        `<td class="c-age" style="color:var(--ink-dim)">${escapeHtml(d.summary || "-")}</td>` +
        `<td class="c-age">${ageTxt} <span style="opacity:.6">×${d.count|0}</span></td>`;
      frag.appendChild(tr);
    }
    rfTbody.replaceChildren(frag);
  }

  // RF flag toggles — same UX as wifi/bt; key is the rtl_433 device_key.
  if (rfTbody) {
    rfTbody.addEventListener("click", async (ev) => {
      const btn = ev.target.closest(".flag-btn");
      if (!btn) return;
      const tr = btn.closest("tr");
      const key = tr && tr.dataset.rfkey;
      if (!key) return;
      const kind = btn.dataset.kind;
      const next = btn.dataset.on === "1" ? 0 : 1;
      const prevOn = btn.dataset.on;
      btn.dataset.on = String(next);
      if (kind === "wl") tr.classList.toggle("row-wl", next === 1);
      if (kind === "tg") tr.classList.toggle("row-tg", next === 1);
      try {
        const body = kind === "wl" ? { whitelisted: next === 1 } : { targeted: next === 1 };
        const r = await fetch(`/api/rf/${encodeURIComponent(key)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
        const verb = next === 1 ? "+" : "-";
        const tag = kind === "wl" ? "whitelist" : "target";
        pushLog(kind === "tg" ? "tgt" : "sys", `${verb} rf ${tag}  ${key}`);
      } catch (e) {
        btn.dataset.on = prevOn;
        if (kind === "wl") tr.classList.toggle("row-wl", prevOn === "1");
        if (kind === "tg") tr.classList.toggle("row-tg", prevOn === "1");
        pushLog("warn", `! flag toggle failed: ${e}`);
      }
    });
  }

  // ============================================================
  //  WIFI.CLIENTS table — STA frames captured by the tshark sidecar.
  //  Only populates when monitor mode is on; empty placeholder
  //  otherwise tells the operator how to enable it.
  // ============================================================
  const clientsSeen = new Set();
  function updateWifiClients() {
    if (!clientsTbody) return;
    const devs = sim.wifi_clients_visible || [];
    if (devs.length === 0) {
      const placeholder = sim.monitor_on
        ? (sim.wifi_clients_active
            ? "// listening, no STAs heard yet"
            : "// monitor on, sidecar starting...")
        : "// monitor mode off (press [F1] MONITOR)";
      clientsTbody.innerHTML = `<tr class="empty"><td colspan="7">${placeholder}</td></tr>`;
      return;
    }
    const frag = document.createDocumentFragment();
    const nowSec = Date.now() / 1000;
    for (const c of devs) {
      const tr = document.createElement("tr");
      tr.dataset.cmac = c.mac;
      if (c.whitelisted) tr.classList.add("row-wl");
      if (c.targeted)    tr.classList.add("row-tg");
      if (!clientsSeen.has(c.mac)) { tr.classList.add("fresh"); clientsSeen.add(c.mac); }
      const rssiTxt = (c.last_signal != null) ? `${c.last_signal} dBm` : "--";
      const ageS = c.last_seen ? Math.max(0, nowSec - c.last_seen) : null;
      const ageTxt = ageS == null ? "--"
        : ageS < 60 ? `${Math.round(ageS)}s`
        : ageS < 3600 ? `${Math.round(ageS / 60)}m`
        : `${Math.round(ageS / 3600)}h`;
      const macShort = (c.mac || "").toUpperCase();
      const probed = (c.probed_ssids || []).filter(Boolean);
      // Show up to 3 probed SSIDs inline + a "+N more" tail.
      const inline = probed.slice(0, 3).map(escapeHtml).join(", ");
      const more = probed.length > 3 ? ` <span style="opacity:.6">+${probed.length-3}</span>` : "";
      const probedTxt = probed.length === 0 ? '<span style="opacity:.55">(broadcast)</span>'
        : `${inline}${more}`;
      const randChip = c.is_random
        ? '<span class="bt-tag" style="background:rgba(80,200,120,0.10); color:var(--ink-dim)">RAND</span>'
        : '<span style="opacity:.55">--</span>';
      tr.innerHTML =
        `<td class="c-act">` +
          `<button class="flag-btn" data-kind="wl" data-on="${c.whitelisted ? 1 : 0}" title="whitelist">[*]</button>` +
          `<button class="flag-btn" data-kind="tg" data-on="${c.targeted    ? 1 : 0}" title="add to target list">[!]</button>` +
        `</td>` +
        `<td class="c-ssid">${probedTxt}</td>` +
        `<td class="c-bssid">${escapeHtml(macShort)}</td>` +
        `<td class="c-ch">${randChip}</td>` +
        `<td class="c-sig">${rssiTxt}</td>` +
        `<td class="c-enc"><span style="opacity:.7">×${c.probe_count|0}</span></td>` +
        `<td class="c-age">${ageTxt}</td>`;
      frag.appendChild(tr);
    }
    clientsTbody.replaceChildren(frag);
  }

  if (clientsTbody) {
    clientsTbody.addEventListener("click", async (ev) => {
      const btn = ev.target.closest(".flag-btn");
      if (!btn) return;
      const tr = btn.closest("tr");
      const mac = tr && tr.dataset.cmac;
      if (!mac) return;
      const kind = btn.dataset.kind;
      const next = btn.dataset.on === "1" ? 0 : 1;
      const prevOn = btn.dataset.on;
      btn.dataset.on = String(next);
      if (kind === "wl") tr.classList.toggle("row-wl", next === 1);
      if (kind === "tg") tr.classList.toggle("row-tg", next === 1);
      try {
        const body = kind === "wl" ? { whitelisted: next === 1 } : { targeted: next === 1 };
        const r = await fetch(`/api/clients/${encodeURIComponent(mac)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
        const verb = next === 1 ? "+" : "-";
        const tag = kind === "wl" ? "whitelist" : "target";
        pushLog(kind === "tg" ? "tgt" : "sys", `${verb} client ${tag}  ${mac}`);
      } catch (e) {
        btn.dataset.on = prevOn;
        if (kind === "wl") tr.classList.toggle("row-wl", prevOn === "1");
        if (kind === "tg") tr.classList.toggle("row-tg", prevOn === "1");
        pushLog("warn", `! flag toggle failed: ${e}`);
      }
    });
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

    // SDR — surfaced as rtl_433 when that's the active consumer of the
    // dongle, else legacy rtl_power. They're mutually exclusive so the
    // two states share a card.
    const r4 = s.rtl433 || {};
    const d = s.sdr || {};
    if (r4.active) {
      setCard("sdr", "1",
        (r4.last_age_s != null && r4.last_age_s < 30) ? "RTL_433 / DECODE" : "RTL_433 / IDLE",
        [
          `${r4.devices_total || 0} devices :: ${r4.targets_total || 0} target`,
          r4.last_age_s != null ? `last decode ${fmtAge(r4.last_age_s)}` : "no decodes yet",
        ]);
    } else if (d.active) {
      setCard("sdr", "1", d.last_peaks > 0 ? "RTL_POWER ACTIVE" : "RTL_POWER SWEEPING", [
        `${d.last_band || "--"} :: ${d.last_peaks || 0} peak`,
        `${d.bands_count} band :: ${s.rf_signals_total} tot :: ${fmtAge(d.last_age_s)}`,
      ]);
    } else {
      setCard("sdr", "0", "OFF",
        ["no SDR consumer running",
         "set WARDRIVE_RTL433_ENABLED=1 (decoder) or WARDRIVE_SDR_ENABLED=1 (peaks)"]);
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
        sim.rtl433_active = !!s.rtl433_active;
        sim.rf_visible = Array.isArray(s.rf_visible) ? s.rf_visible : [];
        sim.rf_devices_total = s.rf_devices_total || 0;
        sim.rf_targets_total = s.rf_targets_total || 0;
        sim.wifi_clients_active = !!s.wifi_clients_active;
        sim.wifi_clients_visible = Array.isArray(s.wifi_clients_visible) ? s.wifi_clients_visible : [];
        sim.wifi_clients_total = s.wifi_clients_total || 0;
        sim.wifi_client_targets_total = s.wifi_client_targets_total || 0;
        sim.mission = s.mission || { status: "idle" };
        sim.snapshot = s;

        reactToSnapshot(s);
        prev.snapshot = s;

        updateChrome();
        updateRadioPanel(s);
        updateLiveNets();
        updateBtDevices();
        updateRfDevices();
        updateWifiClients();
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ============================================================
  //  Runtime feature toggles (CONFIG modal)
  //  Loads feature state on demand + on every modal open. Each
  //  feature gets a tristate toggle [DEFAULT|ON|OFF] that PUTs to
  //  /api/features/{name}.
  // ============================================================
  const featuresList = document.getElementById("features-list");

  async function loadFeatures() {
    if (!featuresList) return;
    let payload;
    try {
      const r = await fetch("/api/features");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      payload = await r.json();
    } catch (e) {
      featuresList.innerHTML = `<div style="color:var(--red); font-size:13px;">! load failed: ${e}</div>`;
      return;
    }
    renderFeatures(payload.features || []);
  }
  function renderFeatures(features) {
    if (!featuresList) return;
    featuresList.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const f of features) {
      const row = document.createElement("div");
      row.className = "feature-row";
      row.dataset.feature = f.name;
      const stateChip = f.enabled
        ? '<span class="feat-state live">[ LIVE ]</span>'
        : '<span class="feat-state dead">[ idle ]</span>';
      const envHint = `default: ${f.env_default ? "ON" : "OFF"}  (${f.env_var})`;
      const ov = (f.override || "default").toLowerCase();
      row.innerHTML = `
        <div>
          <div class="feat-name">${escapeHtml(f.name.toUpperCase())} ${stateChip}</div>
          <div class="feat-meta">${escapeHtml(f.description)}</div>
          <div class="feat-meta">${escapeHtml(envHint)}</div>
        </div>
        <div class="feat-toggle" role="group" aria-label="${escapeHtml(f.name)} override">
          <button data-val="default" class="${ov === "default" ? "sel" : ""}">DEFAULT</button>
          <button data-val="on"      class="${ov === "on" ? "sel" : ""}">ON</button>
          <button data-val="off"     class="${ov === "off" ? "sel off" : ""}">OFF</button>
        </div>
      `;
      frag.appendChild(row);
    }
    featuresList.appendChild(frag);
  }
  if (featuresList) {
    featuresList.addEventListener("click", async (ev) => {
      const btn = ev.target.closest(".feat-toggle button");
      if (!btn) return;
      const row = btn.closest(".feature-row");
      const name = row && row.dataset.feature;
      if (!name) return;
      const val = btn.dataset.val;
      try {
        const r = await fetch(`/api/features/${encodeURIComponent(name)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ override: val }),
        });
        if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
        pushLog("sys", `! feature ${name} -> ${val}`);
        await loadFeatures();
      } catch (e) {
        pushLog("warn", `! feature toggle failed: ${e}`);
      }
    });
  }

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
    await Promise.all([loadIfaces(), loadFeatures()]);
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

  // ============================================================
  //  Mission lifecycle modal
  // ============================================================
  const missionModal = document.getElementById("mission-modal");
  const missionPill  = document.getElementById("mission-pill");
  const btnMission   = document.getElementById("btn-mission");
  const btnMClose    = document.getElementById("btn-mission-close");
  const btnMStart    = document.getElementById("btn-mission-start");
  const btnMEnd      = document.getElementById("btn-mission-end");
  const btnMDismiss  = document.getElementById("btn-mission-dismiss");
  const btnMBackup   = document.getElementById("btn-mission-backup");
  const missionLabel = document.getElementById("mission-label");
  const missionTitle = document.getElementById("mission-modal-title");
  const paneIdle     = document.getElementById("mission-idle");
  const paneActive   = document.getElementById("mission-active");
  const paneDebrief  = document.getElementById("mission-debrief");
  const liveBox      = document.getElementById("mission-live");
  const debriefBox   = document.getElementById("mission-debrief-stats");
  const debriefRes   = document.getElementById("mission-debrief-result");
  const historyBox   = document.getElementById("mission-history");

  function openMissionModal() {
    if (!missionModal) return;
    missionModal.hidden = false;
    renderMissionPanes();
    if ((sim.mission && sim.mission.status) === "idle") {
      loadMissionHistory();
    }
  }
  function closeMissionModal() { if (missionModal) missionModal.hidden = true; }

  function fmtDur(s) {
    if (s == null) return "--";
    s = Math.max(0, s | 0);
    const h = (s / 3600) | 0;
    const m = ((s / 60) | 0) % 60;
    const sec = s % 60;
    if (h) return `${h}h${pad(m,2)}m${pad(sec,2)}s`;
    if (m) return `${m}m${pad(sec,2)}s`;
    return `${sec}s`;
  }
  function fmtDist(meters) {
    if (meters == null) return "--";
    if (meters < 1000) return `${meters.toFixed(0)} m`;
    return `${(meters / 1000).toFixed(2)} km`;
  }

  function renderMissionPanes() {
    const m = sim.mission || {};
    const status = m.status || "idle";
    if (missionTitle) {
      missionTitle.textContent = `// MISSION :: ${status.toUpperCase()}`;
    }
    if (paneIdle)    paneIdle.hidden    = (status !== "idle");
    if (paneActive)  paneActive.hidden  = (status !== "active");
    if (paneDebrief) paneDebrief.hidden = (status !== "debriefing");

    if (status === "active" && liveBox) {
      // Live stats are computed client-side from the sim totals — the
      // backend hands a final summary back when the mission ends.
      const elapsed = m.started_at ? Math.max(0, (Date.now()/1000) - m.started_at) : 0;
      liveBox.innerHTML = `
        <table class="live-nets" style="margin-bottom:8px;">
          <tr><td>started</td><td>${m.started_at ? new Date(m.started_at*1000).toLocaleString() : '--'}</td></tr>
          <tr><td>elapsed</td><td>${escapeHtml(fmtDur(elapsed))}</td></tr>
          <tr><td>label</td><td>${escapeHtml(m.label || '(none)')}</td></tr>
          <tr><td>networks total</td><td>${sim.networks|0}</td></tr>
          <tr><td>bt devices total</td><td>${sim.bt_devices_total|0}</td></tr>
          <tr><td>rf devices total</td><td>${sim.rf_devices_total|0}</td></tr>
          <tr><td>wifi clients total</td><td>${sim.wifi_clients_total|0}</td></tr>
        </table>
        <div style="font-size:12px; color: var(--ink-dim);">
          totals are cumulative; the debriefing summary will isolate just
          what was new during this mission window.
        </div>
      `;
    }
    if (status === "debriefing" && debriefBox) {
      const summary = m.summary || {};
      const pts = summary.points || 0;
      debriefBox.innerHTML = `
        <table class="live-nets">
          <tr><td>points</td><td><span style="color:var(--amber); text-shadow: 0 0 6px rgba(255,180,80,0.5); font-weight:700;">${pts}</span></td></tr>
          <tr><td>duration</td><td>${escapeHtml(fmtDur(summary.duration_s))}</td></tr>
          <tr><td>distance</td><td>${escapeHtml(fmtDist(summary.distance_m))}</td></tr>
          <tr><td>new networks</td><td>${summary.new_networks || 0}</td></tr>
          <tr><td>new wifi clients</td><td>${summary.new_clients || 0}</td></tr>
          <tr><td>new bt devices</td><td>${summary.new_bt_devices || 0}</td></tr>
          <tr><td>new rf devices</td><td>${summary.new_rf_devices || 0}</td></tr>
          <tr><td>label</td><td>${escapeHtml(m.label || '(none)')}</td></tr>
        </table>
      `;
    }
  }

  async function loadMissionHistory() {
    if (!historyBox) return;
    try {
      const r = await fetch("/api/missions?limit=8");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = await r.json();
      if (!list.length) {
        historyBox.innerHTML = '<div style="color:var(--ink-faint); font-size:12px;">// no missions yet</div>';
        return;
      }
      const rows = list.map(mi => {
        const s = mi.summary || {};
        const when = mi.started_at ? new Date(mi.started_at*1000).toLocaleString() : '--';
        return `<tr>
          <td>${mi.id}</td>
          <td>${escapeHtml(when)}</td>
          <td>${escapeHtml(fmtDur(s.duration_s))}</td>
          <td>${escapeHtml(fmtDist(s.distance_m))}</td>
          <td>${s.new_networks || 0}n / ${s.new_clients || 0}sta / ${s.new_bt_devices || 0}bt / ${s.new_rf_devices || 0}rf</td>
          <td><span style="color: var(--amber);">${s.points || 0}</span></td>
        </tr>`;
      }).join("");
      historyBox.innerHTML = `
        <table class="live-nets">
          <thead><tr><th>#</th><th>STARTED</th><th>DUR</th><th>DIST</th><th>NEW</th><th>PTS</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    } catch (e) {
      historyBox.innerHTML = `<div style="color:var(--red); font-size:12px;">! ${e}</div>`;
    }
  }

  if (btnMission)   btnMission.addEventListener("click", openMissionModal);
  if (btnMClose)    btnMClose.addEventListener("click", closeMissionModal);
  if (missionModal) missionModal.addEventListener("click", (ev) => {
    if (ev.target === missionModal) closeMissionModal();
  });
  if (missionPill)  missionPill.style.cursor = "pointer", missionPill.addEventListener("click", openMissionModal);

  if (btnMStart) btnMStart.addEventListener("click", async () => {
    const label = (missionLabel && missionLabel.value || "").trim();
    try {
      const r = await fetch("/api/mission/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
      sim.mission = await r.json();
      pushLog("sys", `! mission started${label ? ` — ${label}` : ""}`);
      renderMissionPanes();
    } catch (e) { pushLog("warn", `! mission start failed: ${e}`); }
  });

  if (btnMEnd) btnMEnd.addEventListener("click", async () => {
    try {
      const r = await fetch("/api/mission/end", { method: "POST" });
      if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
      sim.mission = await r.json();
      const pts = (sim.mission.summary && sim.mission.summary.points) || 0;
      pushLog("sys", `! mission ended — debriefing  (${pts} pts)`);
      renderMissionPanes();
    } catch (e) { pushLog("warn", `! mission end failed: ${e}`); }
  });

  if (btnMDismiss) btnMDismiss.addEventListener("click", async () => {
    try {
      const r = await fetch("/api/mission/dismiss", { method: "POST" });
      if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
      sim.mission = await r.json();
      pushLog("sys", `! debriefing dismissed`);
      renderMissionPanes();
      loadMissionHistory();
    } catch (e) { pushLog("warn", `! dismiss failed: ${e}`); }
  });

  if (btnMBackup) btnMBackup.addEventListener("click", async () => {
    btnMBackup.disabled = true;
    if (debriefRes) debriefRes.textContent = "backup running...";
    try {
      const r = await fetch("/api/backup", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
      if (debriefRes) debriefRes.textContent = `backup ok :: ${j.path} (${j.bytes|0} bytes)`;
      pushLog("sys", `! db backup -> ${j.path}`);
    } catch (e) {
      if (debriefRes) debriefRes.textContent = `! backup failed: ${e}`;
      pushLog("warn", `! backup failed: ${e}`);
    } finally {
      btnMBackup.disabled = false;
    }
  });

  // Keep the modal up-to-date as ws snapshots arrive while it's open.
  function refreshMissionModalIfOpen() {
    if (missionModal && !missionModal.hidden) renderMissionPanes();
  }
  // Hook into the existing ws callback by piggybacking on updateChrome.
  const _origUpdateChrome = updateChrome;
  updateChrome = function() {
    _origUpdateChrome();
    refreshMissionModalIfOpen();
  };

  // boot
  pushLog("sys", `! wardrive//terminal online`);
  pushLog("sys", `! awaiting telemetry...`);
  updateChrome();
  connectWs();
  requestAnimationFrame(loop);
})();
