/* WARDRIVE CREW — 16-bit GBA-style renderer
 *
 * Native canvas: 320×180 pixels. The page sets the canvas's CSS
 * width to its container; setting `imageSmoothingEnabled = false`
 * keeps the upscale crisp.
 *
 * Scene composition (back → front):
 *   1. Sky gradient + parallax clouds + GPS satellites
 *   2. Far hills (slow parallax)
 *   3. Mid scenery (trees / billboards)
 *   4. Road with perspective dashes
 *   5. Fleet ghost cars (LoRa beacons)
 *   6. Player vehicle + spinning wheels + dust
 *   7. Animal cast — one per active radio, riding in the seats
 *   8. Particles (packet sparks, RF ripples, LoRa puffs)
 *   9. Dashboard HUD strip
 *
 * The cast is dynamic: every frame we look at which radios are
 * active in the latest snapshot and fill seats with the matching
 * animals. No active radios → empty seats.
 */
(() => {
  "use strict";

  const W = 320, H = 180;

  // ------------------------------------------------------------
  //  state
  // ------------------------------------------------------------
  let cv = null;
  let ctx = null;
  let running = false;
  let _rafId = null;
  let _ws = null;
  let _wsReconnectTimer = null;

  let frame = 0;
  let lastTick = 0;
  let scrollX = 0;        // road scroll offset (pixels)

  const sim = {
    speed_mph: 0,
    networks_total: 0,
    packets_total: 0,
    rf_signals_total: 0,
    rf_window: 0,
    monitor_on: false,
    pcap_on: false,
    gps_on: false,
    gps_sat_count: 0,
    gps_accuracy_m: 0,
    gps_source: "none",
    rtc_synced: false,
    sdr_active: false,
    sdr_last_band: "",
    sdr_last_peaks: 0,
    lora_active: false,
    lora_tx_count: 0,
    lora_rx_count: 0,
    crew_id: "",
    fleet: [],
    status: "",
    last_scan_new: 0,
    last_scan_seen: 0,
  };
  let prev = JSON.parse(JSON.stringify(sim));

  // Per-animal react timer (decrements each tick). When > 0, animal
  // plays its react frames instead of idle.
  const reactTimer = {};

  // ------------------------------------------------------------
  //  drawing primitives — operate on the native 320×180 canvas
  // ------------------------------------------------------------
  const D = {
    px(x, y, color) {
      ctx.fillStyle = color;
      ctx.fillRect(x | 0, y | 0, 1, 1);
    },
    fillRect(x, y, w, h, color) {
      ctx.fillStyle = color;
      ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
    },
    line(x1, y1, x2, y2, color) {
      // Bresenham — keeps lines crisp at 1px
      x1 |= 0; y1 |= 0; x2 |= 0; y2 |= 0;
      const dx = Math.abs(x2 - x1);
      const dy = -Math.abs(y2 - y1);
      const sx = x1 < x2 ? 1 : -1;
      const sy = y1 < y2 ? 1 : -1;
      let err = dx + dy;
      ctx.fillStyle = color;
      while (true) {
        ctx.fillRect(x1, y1, 1, 1);
        if (x1 === x2 && y1 === y2) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x1 += sx; }
        if (e2 <= dx) { err += dx; y1 += sy; }
      }
    },
    sprite(x, y, def, frameKey, frameIdx, flipH = false) {
      const frames = def.frames[frameKey] || def.frames.idle;
      const rows = frames[frameIdx % frames.length];
      const pal = def.palette;
      const w = def.size.w;
      x |= 0; y |= 0;
      for (let row = 0; row < rows.length; row++) {
        const line = rows[row];
        for (let col = 0; col < w; col++) {
          const ch = line.charCodeAt(col);
          if (!ch || ch === 46) continue;  // '.' = transparent
          const idx = ch - 48;             // '0'-'9'
          const color = pal[idx];
          if (!color) continue;
          const dx = flipH ? (w - 1 - col) : col;
          ctx.fillStyle = color;
          ctx.fillRect(x + dx, y + row, 1, 1);
        }
      }
    },
    circle(cx, cy, r, color) {
      // Filled circle via midpoint-circle scanlines (small radii, no AA).
      ctx.fillStyle = color;
      cx |= 0; cy |= 0; r |= 0;
      for (let dy = -r; dy <= r; dy++) {
        const w = Math.floor(Math.sqrt(r * r - dy * dy));
        ctx.fillRect(cx - w, cy + dy, 2 * w + 1, 1);
      }
    },
    ring(cx, cy, r, color) {
      // 1-pixel ring outline using midpoint circle algorithm.
      ctx.fillStyle = color;
      cx |= 0; cy |= 0; r |= 0;
      let x = r, y = 0, err = 0;
      while (x >= y) {
        ctx.fillRect(cx + x, cy + y, 1, 1);
        ctx.fillRect(cx + y, cy + x, 1, 1);
        ctx.fillRect(cx - y, cy + x, 1, 1);
        ctx.fillRect(cx - x, cy + y, 1, 1);
        ctx.fillRect(cx - x, cy - y, 1, 1);
        ctx.fillRect(cx - y, cy - x, 1, 1);
        ctx.fillRect(cx + y, cy - x, 1, 1);
        ctx.fillRect(cx + x, cy - y, 1, 1);
        y += 1;
        err += 1 + 2 * y;
        if (2 * (err - x) + 1 > 0) { x -= 1; err += 1 - 2 * x; }
      }
    },
    text(x, y, str, color) {
      // 5×7 bitmap font, monospaced, 1px tracking. Lazy: use the
      // canvas text API at integer coords. For a true pixel font
      // we'd ship our own glyphs; this is "close enough" for HUD.
      ctx.fillStyle = color;
      ctx.font = "8px monospace";
      ctx.textBaseline = "top";
      ctx.fillText(str, x | 0, y | 0);
    },
  };

  // ------------------------------------------------------------
  //  scene primitives
  // ------------------------------------------------------------
  function drawSky() {
    // Vertical gradient via horizontal bands. 3 stops gives a clean
    // GBA pixel feel without alpha blending.
    D.fillRect(0,  0, W, 30,  "#86b8e0");
    D.fillRect(0, 30, W, 25,  "#a0d0f0");
    D.fillRect(0, 55, W, 20,  "#c8e8f8");
  }

  function drawClouds() {
    // 3 clouds at fixed positions, slow parallax
    const off = (scrollX * 0.05) | 0;
    const clouds = [
      { x: 30,  y: 14 },
      { x: 130, y:  8 },
      { x: 240, y: 20 },
    ];
    clouds.forEach(c => {
      const cx = ((c.x - off) % (W + 50) + (W + 50)) % (W + 50) - 25;
      D.circle(cx,      c.y,     5, "#f4f8fc");
      D.circle(cx + 6,  c.y - 2, 4, "#f4f8fc");
      D.circle(cx + 12, c.y,     5, "#f4f8fc");
    });
  }

  function drawSatellites() {
    // One sat sprite per gps_sat_count, sprinkled across the sky
    const n = Math.min(sim.gps_sat_count || 0, 8);
    if (n <= 0) return;
    for (let i = 0; i < n; i++) {
      const cx = 20 + i * 36;
      const cy = 6 + ((i * 7) % 12);
      // tiny satellite: solar panels + body, blinks every 8 frames
      const blink = ((frame >> 3) + i) & 1;
      D.fillRect(cx,     cy,     6, 2, "#c0c0d0");   // left panel
      D.fillRect(cx + 8, cy,     6, 2, "#c0c0d0");   // right panel
      D.fillRect(cx + 5, cy - 1, 4, 4, "#e0e0f0");   // body
      if (blink) D.px(cx + 7, cy, "#fff8a0");
    }
  }

  function drawHills() {
    // Mid-distance hill silhouette, slow parallax
    const off = (scrollX * 0.15) | 0;
    ctx.fillStyle = "#5a7858";
    for (let x = -off; x < W + 60; x += 60) {
      ctx.beginPath();
      ctx.moveTo(x, 90);
      ctx.lineTo(x + 30, 65);
      ctx.lineTo(x + 60, 90);
      ctx.lineTo(x, 90);
      ctx.fill();
    }
    D.fillRect(0, 88, W, 3, "#3a5840");  // hill base / horizon strip
  }

  function drawTrees() {
    // Trees scroll at half-speed of the road
    const off = (scrollX * 0.4) | 0;
    const spacing = 70;
    for (let i = 0; i < 6; i++) {
      const tx = ((i * spacing - off) % (W + spacing) + (W + spacing)) % (W + spacing) - spacing / 2;
      const ty = 88;
      // trunk
      D.fillRect(tx + 6, ty + 4, 2, 8, "#604020");
      // canopy
      D.circle(tx + 7, ty + 2, 6, "#306030");
      D.circle(tx + 7, ty + 2, 4, "#408040");
    }
  }

  function drawRoad() {
    // Road plate
    D.fillRect(0, 100, W, 50, "#3a3a40");
    // Curb stripes
    D.fillRect(0, 100, W, 1, "#a0a0a8");
    D.fillRect(0, 148, W, 1, "#a0a0a8");
    // Center dashes — perspective: dashes near the bottom are wider
    const off = scrollX | 0;
    const dashLen = 14;
    const gap = 18;
    const period = dashLen + gap;
    for (let x = -((off) % period) - dashLen; x < W; x += period) {
      D.fillRect(x, 122, dashLen, 3, "#e0e040");
    }
    // Dirt verge below curb
    D.fillRect(0, 149, W, 4, "#6a5840");
  }

  function drawDust(carX, carY) {
    // Small dust puff under the trailing wheel; 2 puffs based on phase
    const dustY = carY + 32;
    const baseX = carX - 4;
    for (let i = 0; i < 3; i++) {
      const on = ((frame + i) % 4) === 0;
      if (!on) continue;
      const off = i * 6;
      D.circle(baseX - off, dustY - (i & 1), 2 + i, "#d0c0a0");
    }
  }

  function drawWheel(cx, cy, r, phase) {
    D.circle(cx, cy, r, "#1a1a22");                // tire
    D.circle(cx, cy, r - 2, "#404048");            // hub
    // Rotating spokes — 4 positions
    const ang = (phase % 4) * (Math.PI / 4);
    for (let s = 0; s < 4; s++) {
      const a = ang + s * (Math.PI / 2);
      const x2 = cx + Math.cos(a) * (r - 3);
      const y2 = cy + Math.sin(a) * (r - 3);
      D.line(cx, cy, x2, y2, "#a0a0b0");
    }
    D.fillRect(cx - 1, cy - 1, 2, 2, "#c0c0d0");   // hubcap
  }

  function drawAntennaWaves(ax, ay, intensity, phase) {
    // mast
    D.line(ax, ay, ax, ay - 14, "#c0c0d0");
    D.fillRect(ax - 1, ay - 16, 2, 2, "#c0c0d0");
    // up to 3 arc rings, lit progressively with phase + intensity
    const n = Math.max(1, Math.min(3, Math.round(intensity * 3)));
    for (let i = 0; i < 3; i++) {
      const lit = i < n && ((phase + i) % 4) !== 0;
      if (!lit) continue;
      const r = 4 + i * 3;
      ctx.strokeStyle = "#74e070";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(ax + 2, ay - 14, r, -Math.PI / 2.2, Math.PI / 2.2);
      ctx.stroke();
    }
  }

  function drawPacketSparks(carX, carY) {
    // Tiny dots streaming away from the antenna toward the back of
    // the car when pcap_bytes_rate_s > 0 OR network discoveries are
    // happening. Density scales with rate.
    const rate = (sim.snapshot && sim.snapshot.wifi
                    && sim.snapshot.wifi.pcap_bytes_rate_s) || 0;
    const density = Math.min(8, Math.floor(rate / 200) + (sim.last_scan_new || 0));
    if (density <= 0) return;
    for (let i = 0; i < density; i++) {
      const t = ((frame + i * 5) % 60) / 60;
      const x = carX + 100 - t * 90;
      const y = carY - 12 + ((i * 7) % 6);
      D.fillRect(x, y, 2, 2, "#fff8a0");
    }
  }

  function drawRfRipple(carX, carY) {
    if (!sim.sdr_active) return;
    const peaks = sim.sdr_last_peaks || 0;
    if (peaks <= 0) return;
    const phase = (frame % 12) / 12;
    const r = 2 + phase * 12;
    ctx.strokeStyle = `rgba(160, 220, 255, ${1 - phase})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(carX + 20, carY + 16, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawFleetGhosts() {
    const fleet = sim.fleet || [];
    if (fleet.length === 0) return;
    const myScore = sim.networks_total || 0;
    fleet.slice(0, 3).forEach((m, i) => {
      const delta = (m.score || 0) - myScore;
      const xOff = Math.max(-120, Math.min(120, delta * 2));
      const gx = (W / 2) + xOff + (i % 2 === 0 ? -50 : 50) - 20;
      const gy = 122 + i * 2;
      // tiny silhouette
      D.fillRect(gx, gy, 30, 8, "rgba(40,40,60,0.7)");
      D.fillRect(gx + 4, gy - 4, 22, 4, "rgba(40,40,60,0.7)");
      D.circle(gx + 6, gy + 9, 2, "rgba(20,20,30,0.8)");
      D.circle(gx + 24, gy + 9, 2, "rgba(20,20,30,0.8)");
      // crew tag
      D.text(gx, gy - 12, m.crew_id || "", "#202030");
    });
  }

  // ------------------------------------------------------------
  //  Cast computation: which animals ride along right now?
  //  Each animal entry has an `iface` string; we look up which
  //  radios are active and put the corresponding animal in a seat.
  // ------------------------------------------------------------
  const CAST_ORDER = ["wifi", "pcap", "gps", "sdr", "lora", "rtc"];

  function ifaceActive(iface) {
    switch (iface) {
      case "wifi":  return true;             // always present (scanner runs)
      case "pcap":  return !!sim.pcap_on;
      case "gps":   return !!sim.gps_on;
      case "sdr":   return !!sim.sdr_active;
      case "lora":  return !!sim.lora_active;
      case "rtc":   return !!sim.rtc_synced;
      default:      return false;
    }
  }

  function activeCast() {
    const out = [];
    for (const iface of CAST_ORDER) {
      const id = Object.keys(window.ANIMAL_SPRITES || {}).find(
        a => window.ANIMAL_SPRITES[a].iface === iface
      );
      if (id && ifaceActive(iface)) out.push(id);
    }
    return out;
  }

  function drawCar() {
    const veh = (window.VEHICLE_SPRITES && window.VEHICLE_SPRITES.recon_wagon)
      || null;
    if (!veh) return;

    const carX = (W - veh.size.w) / 2 | 0;
    const carY = 96;

    // shadow
    D.fillRect(carX + 4, carY + veh.size.h - 1, veh.size.w - 8, 2, "rgba(0,0,0,0.35)");

    // chassis
    veh.draw(D, carX, carY, frame, sim);

    // wheels
    veh.wheels.forEach(w => drawWheel(carX + w.x, carY + w.y, w.r, frame));
    drawDust(carX, carY);

    // antennas + arc waves; intensity comes from active scan/RF
    const wifiIntensity = (sim.last_scan_new || 0) > 0
      ? Math.min(1, (sim.last_scan_new || 0) / 5)
      : (sim.monitor_on ? 0.6 : 0.3);
    veh.antennas.forEach(a => drawAntennaWaves(carX + a.x, carY + a.y, wifiIntensity, frame));

    // particles
    drawPacketSparks(carX, carY);
    drawRfRipple(carX, carY);

    // cast — paint each active animal in its seat
    const cast = activeCast();
    for (let i = 0; i < cast.length && i < veh.seats; i++) {
      const animId = cast[i];
      const animal = window.ANIMAL_SPRITES[animId];
      if (!animal) continue;
      const seat = veh.seatPositions[i];
      const reacting = (reactTimer[animId] || 0) > 0;
      const frameKey = reacting ? "react" : "idle";
      const fIdx = reacting ? 0 : (frame >> 3) & 1;
      D.sprite(carX + seat.x, carY + seat.y, animal, frameKey, fIdx);
    }
  }

  // ------------------------------------------------------------
  //  Dashboard HUD strip — bottom of the screen, contains every
  //  number the radio panel used to show.
  // ------------------------------------------------------------
  function drawDashboard() {
    const top = 153;
    D.fillRect(0,  top,     W, 27, "#101014");
    D.fillRect(0,  top,     W,  1, "#404048");
    D.fillRect(0,  top + 1, W,  1, "#202028");

    // Speedometer (left)
    const cx = 26, cy = top + 14, r = 11;
    D.circle(cx, cy, r,     "#202028");
    D.circle(cx, cy, r - 1, "#101014");
    // tick marks
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI + i * (Math.PI / 7);
      const x1 = cx + Math.cos(a) * (r - 1);
      const y1 = cy + Math.sin(a) * (r - 1);
      const x2 = cx + Math.cos(a) * (r - 3);
      const y2 = cy + Math.sin(a) * (r - 3);
      D.line(x1, y1, x2, y2, "#606070");
    }
    // needle — sweeps from -π (0 mph) to 0 (220 mph)
    const speed = sim.speed_mph || 0;
    const needleA = -Math.PI + Math.min(1, speed / 220) * Math.PI;
    const nx = cx + Math.cos(needleA) * (r - 2);
    const ny = cy + Math.sin(needleA) * (r - 2);
    D.line(cx, cy, nx, ny, "#ff5040");
    D.circle(cx, cy, 1, "#ffc040");
    D.text(cx - 8, top + 2, "MPH", "#a0a0b0");

    // Networks odometer (next column)
    const odoX = 50;
    D.text(odoX, top + 4,  "NET", "#a0a0b0");
    D.text(odoX, top + 14, pad(sim.networks_total | 0, 6), "#74e070");

    // Packets
    const pktX = 100;
    D.text(pktX, top + 4,  "PKT", "#a0a0b0");
    D.text(pktX, top + 14, pad(sim.packets_total | 0, 7), "#74e070");

    // RF total
    const rfX = 160;
    D.text(rfX, top + 4,  "RF",  "#a0a0b0");
    D.text(rfX, top + 14, pad(sim.rf_signals_total | 0, 6), sim.sdr_active ? "#74c0e0" : "#404050");

    // Crew + fleet
    const crewX = 210;
    D.text(crewX, top + 4,  "CREW", "#a0a0b0");
    D.text(crewX, top + 14, sim.crew_id || "—", sim.lora_active ? "#e0a0c0" : "#404050");
    D.text(crewX + 50, top + 14, `f${(sim.fleet || []).length}`, "#a0a0b0");

    // GPS coords (if fix)
    const gpsX = 0;
    if (sim.gps_on && sim.snapshot && sim.snapshot.gps) {
      const g = sim.snapshot.gps;
      const acc = g.accuracy_m ? `±${Math.round(g.accuracy_m)}m` : "";
      D.text(gpsX, H - 9, `${g.lat.toFixed(3)},${g.lon.toFixed(3)} ${acc}`, "#74e070");
    } else {
      D.text(gpsX, H - 9, "no gps fix", "#604040");
    }

    // RTC clock face on the far right (if synced)
    if (sim.rtc_synced) {
      const rcx = W - 16, rcy = top + 14, rr = 9;
      D.circle(rcx, rcy, rr, "#202028");
      D.circle(rcx, rcy, rr - 1, "#f0e8d0");
      const now = new Date();
      const ha = -Math.PI / 2 + ((now.getHours() % 12) / 12) * Math.PI * 2;
      const ma = -Math.PI / 2 + (now.getMinutes() / 60) * Math.PI * 2;
      D.line(rcx, rcy, rcx + Math.cos(ha) * 4, rcy + Math.sin(ha) * 4, "#202028");
      D.line(rcx, rcy, rcx + Math.cos(ma) * 6, rcy + Math.sin(ma) * 6, "#404048");
      D.text(rcx - 10, top + 2, "RTC", "#a0a0b0");
    }

    // Status ticker (very bottom)
    if (sim.status) {
      D.text(2, H - 9, "                  " + sim.status, "#808090");
    }
  }

  function pad(n, w) { return String(n).padStart(w, "0"); }

  // ------------------------------------------------------------
  //  Tick & render
  // ------------------------------------------------------------
  function tickHz() {
    return Math.min(2 + (sim.speed_mph || 0) / 7, 28);
  }

  function fireReactions() {
    for (const id of Object.keys(window.ANIMAL_SPRITES || {})) {
      const def = window.ANIMAL_SPRITES[id];
      if (typeof def.reactOn !== "function") continue;
      try {
        if (def.reactOn(sim, prev)) reactTimer[id] = 16;  // ~1s @ 16Hz
      } catch (e) { /* ignore predicate errors */ }
    }
    for (const id of Object.keys(reactTimer)) {
      if (reactTimer[id] > 0) reactTimer[id]--;
    }
  }

  function render() {
    drawSky();
    drawClouds();
    drawSatellites();
    drawHills();
    drawTrees();
    drawRoad();
    drawFleetGhosts();
    drawCar();
    drawDashboard();
  }

  function loop(now) {
    if (!running) return;
    const dt = 1000 / tickHz();
    if (now - lastTick >= dt) {
      frame = (frame + 1) | 0;
      // road scroll proportional to speed
      scrollX = (scrollX + 1 + Math.floor((sim.speed_mph || 0) / 12)) | 0;
      fireReactions();
      // copy current sim into prev for next tick's diff
      Object.assign(prev, sim);
      lastTick = now;
    }
    render();
    _rafId = requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------
  //  WebSocket — owns its own connection so we don't pay for it
  //  while the LCD renderer is active.
  // ------------------------------------------------------------
  function connectWs() {
    if (!running) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    _ws = new WebSocket(`${proto}//${location.host}/ws`);
    _ws.onmessage = (ev) => {
      try {
        const s = JSON.parse(ev.data);
        sim.speed_mph        = s.speed_mph || 0;
        sim.networks_total   = s.networks_total || 0;
        sim.packets_total    = s.packets_total || 0;
        sim.rf_signals_total = s.rf_signals_total || 0;
        sim.rf_window        = s.rf_window || 0;
        sim.monitor_on       = !!s.monitor_on;
        sim.pcap_on          = !!s.pcap_on;
        sim.gps_on           = !!(s.gps && s.gps.have_fix);
        sim.gps_sat_count    = (s.gps && s.gps.sat_count) || 0;
        sim.gps_accuracy_m   = (s.gps && s.gps.accuracy_m) || 0;
        sim.gps_source       = (s.gps && s.gps.source) || "none";
        sim.rtc_synced       = !!s.rtc_synced;
        sim.sdr_active       = !!s.sdr_active;
        sim.sdr_last_band    = (s.sdr && s.sdr.last_band) || "";
        sim.sdr_last_peaks   = (s.sdr && s.sdr.last_peaks) || 0;
        sim.lora_active      = !!s.lora_active;
        sim.lora_tx_count    = (s.lora && s.lora.tx_count) || 0;
        sim.lora_rx_count    = (s.lora && s.lora.rx_count) || 0;
        sim.crew_id          = s.crew_id || "";
        sim.fleet            = Array.isArray(s.fleet) ? s.fleet : [];
        sim.status           = s.status || "";
        sim.last_scan_new    = (s.wifi && s.wifi.last_scan_new) || 0;
        sim.last_scan_seen   = (s.wifi && s.wifi.last_scan_seen) || 0;
        sim.snapshot         = s;
      } catch (e) { /* ignore */ }
    };
    _ws.onclose = () => {
      if (running) _wsReconnectTimer = setTimeout(connectWs, 1500);
    };
    _ws.onerror = () => { try { _ws.close(); } catch (e) {} };
  }

  // ------------------------------------------------------------
  //  Renderer interface — registered with the bootstrap
  // ------------------------------------------------------------
  function activate() {
    if (running) return;
    cv = document.getElementById("screen");
    if (!cv) return;
    cv.width = W;
    cv.height = H;
    ctx = cv.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    running = true;
    frame = 0;
    scrollX = 0;
    lastTick = performance.now();
    connectWs();
    _rafId = requestAnimationFrame(loop);
  }
  function deactivate() {
    running = false;
    if (_rafId !== null) {
      cancelAnimationFrame(_rafId);
      _rafId = null;
    }
    if (_wsReconnectTimer !== null) {
      clearTimeout(_wsReconnectTimer);
      _wsReconnectTimer = null;
    }
    if (_ws) { try { _ws.close(); } catch (e) {} _ws = null; }
    if (ctx) ctx.clearRect(0, 0, W, H);
  }

  window.WardriveRenderer = window.WardriveRenderer || {};
  window.WardriveRenderer.sixteen = {
    label: "16-bit (GBA-style)",
    activate,
    deactivate,
  };
})();
