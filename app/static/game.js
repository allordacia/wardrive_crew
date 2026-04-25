/* WARDRIVE CREW — LCD handheld animation
 *
 * Renders a Game-&-Watch-style scene where every element has 2-N discrete
 * "frames". A global tick counter advances at a rate driven by speed_mph
 * pushed from the backend over the websocket. More captures => faster ticks
 * => the car visibly speeds up.
 *
 * Visual style: faint ghost segments drawn for every possible position,
 * dark ink only on the currently-active ones. That's how real LCDs look.
 */

(() => {
  "use strict";

  const W = 640;
  const H = 360;
  const INK = "#14160c";
  const GHOST = "rgba(20, 22, 12, 0.08)";

  const cv = document.getElementById("screen");
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  // ----- state pushed from backend ------------------------------------------
  const sim = {
    speed: 0,
    networks: 0,
    packets: 0,
    monitor_on: false,
    pcap_on: false,
    gps_on: false,
    status: "connecting…",
  };

  // ----- tick driver --------------------------------------------------------
  let frame = 0;
  let lastTick = performance.now();
  function tickHz() {
    // 2 Hz floor, scales with mph. Capped so the canvas doesn't melt.
    const hz = 2 + sim.speed / 7;
    return Math.min(hz, 28);
  }

  // ============================================================
  //  drawing primitives
  // ============================================================
  function seg(active, fn) {
    ctx.fillStyle = active ? INK : GHOST;
    ctx.beginPath();
    fn(ctx);
    ctx.fill();
  }
  function segStroke(active, w, fn) {
    ctx.strokeStyle = active ? INK : GHOST;
    ctx.lineWidth = w;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    fn(ctx);
    ctx.stroke();
  }

  // pixelated rounded rect
  function rrect(c, x, y, w, h, r) {
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
  }

  // ============================================================
  //  scenery (mountains, sun, clouds, signs)
  // ============================================================
  function drawSky(phase) {
    // sun (always on)
    seg(true, c => { c.arc(560, 60, 22, 0, Math.PI * 2); });

    // 3 cloud positions, lit one at a time — gives the parallax illusion
    const clouds = [
      { x: 90, y: 60 },
      { x: 260, y: 45 },
      { x: 430, y: 70 },
    ];
    const lit = phase % clouds.length;
    clouds.forEach((c, i) => drawCloud(c.x, c.y, i === lit));

    // mountain silhouette — always on
    seg(true, c => {
      c.moveTo(0, 200);
      c.lineTo(70, 140);
      c.lineTo(120, 175);
      c.lineTo(180, 120);
      c.lineTo(250, 175);
      c.lineTo(320, 145);
      c.lineTo(400, 180);
      c.lineTo(470, 130);
      c.lineTo(540, 175);
      c.lineTo(620, 150);
      c.lineTo(640, 200);
      c.lineTo(0, 200);
    });
  }
  function drawCloud(x, y, on) {
    seg(on, c => {
      c.arc(x, y, 14, 0, Math.PI * 2);
      c.arc(x + 16, y - 4, 12, 0, Math.PI * 2);
      c.arc(x + 30, y + 2, 14, 0, Math.PI * 2);
      c.arc(x + 14, y + 6, 12, 0, Math.PI * 2);
    });
  }

  // ============================================================
  //  roadside trees / signs (3 fixed positions, cycle through)
  // ============================================================
  function drawRoadside(phase) {
    const items = [
      { x: 60,  draw: drawTree },
      { x: 600, draw: drawSign },
      { x: 30,  draw: drawCactus },
    ];
    // two slots lit at any time, sliding through positions
    items.forEach((it, i) => {
      const on = ((phase + i) % items.length) !== 0;
      it.draw(it.x, on);
    });
  }
  function drawTree(x, on) {
    seg(on, c => {
      c.rect(x - 3, 215, 6, 25);                 // trunk
      c.arc(x, 210, 16, 0, Math.PI * 2);          // canopy
    });
  }
  function drawSign(x, on) {
    seg(on, c => {
      c.rect(x - 1, 215, 2, 30);                  // post
      c.rect(x - 18, 200, 36, 18);                // billboard
    });
  }
  function drawCactus(x, on) {
    seg(on, c => {
      c.rect(x, 215, 5, 28);
      c.rect(x - 8, 222, 5, 12);
      c.rect(x + 8, 220, 5, 14);
    });
  }

  // ============================================================
  //  road (5 dash positions, lit one by one)
  // ============================================================
  function drawRoad(phase) {
    // road surface (always)
    seg(true, c => {
      c.moveTo(0, 250);
      c.lineTo(640, 250);
      c.lineTo(640, 252);
      c.lineTo(0, 252);
    });
    seg(true, c => {
      c.moveTo(0, 320);
      c.lineTo(640, 320);
      c.lineTo(640, 322);
      c.lineTo(0, 322);
    });
    // center dashes — animated marquee
    const dashCount = 8;
    const dashW = 50;
    const gap = 80;
    const lit = phase % dashCount;
    for (let i = 0; i < dashCount; i++) {
      const x = i * gap;
      seg(i === lit || i === ((lit + 3) % dashCount), c => {
        c.rect(x, 283, dashW, 6);
      });
    }
  }

  // ============================================================
  //  CAR — convertible, 4 critters sitting up in plain sight
  // ============================================================
  const CAR_X = 180;
  const CAR_Y = 170;
  const CAR_W = 280;
  const CAR_H = 90;
  // y=200 is the door-top line; animals sit on the seats above it
  const DOOR_Y = CAR_Y + 30;

  function drawCar(phase) {
    // hood (front, right)
    seg(true, c => {
      rrect(c, CAR_X + CAR_W - 60, DOOR_Y + 10, 60, CAR_H - 40, 4);
    });
    // trunk (back, left)
    seg(true, c => {
      rrect(c, CAR_X, DOOR_Y + 10, 50, CAR_H - 40, 4);
    });
    // door / cabin block (between trunk and hood) — open-top
    seg(true, c => {
      rrect(c, CAR_X + 45, DOOR_Y, CAR_W - 105, CAR_H - 30, 4);
    });
    // slanted windshield (front)
    segStroke(true, 3, c => {
      c.moveTo(CAR_X + CAR_W - 60, DOOR_Y);
      c.lineTo(CAR_X + CAR_W - 78, DOOR_Y - 26);
    });
    // rear roll bar (back of cabin)
    segStroke(true, 3, c => {
      c.moveTo(CAR_X + 45, DOOR_Y);
      c.lineTo(CAR_X + 45, DOOR_Y - 18);
    });
    // door seam
    segStroke(true, 2, c => {
      c.moveTo(CAR_X + CAR_W / 2 - 5, DOOR_Y + 4);
      c.lineTo(CAR_X + CAR_W / 2 - 5, CAR_Y + CAR_H);
    });
    // door handles
    seg(true, c => { c.arc(CAR_X + 90, DOOR_Y + 22, 2, 0, Math.PI * 2); });
    seg(true, c => { c.arc(CAR_X + CAR_W - 95, DOOR_Y + 22, 2, 0, Math.PI * 2); });
    // headlight
    seg(true, c => { c.arc(CAR_X + CAR_W - 6, DOOR_Y + 28, 5, 0, Math.PI * 2); });
    // taillight blink
    seg(((phase >> 1) & 1) === 1, c => {
      c.arc(CAR_X + 6, DOOR_Y + 28, 5, 0, Math.PI * 2);
    });
    // steering wheel in front of driver (just a hint)
    segStroke(true, 2, c => {
      c.arc(CAR_X + CAR_W - 75, DOOR_Y + 8, 6, -0.4, Math.PI + 0.4);
    });

    drawWheels(phase);
    drawAnimals(phase);
    drawAntenna(phase);
    drawExhaust(phase);
  }

  function drawWheels(phase) {
    // 4 spoke positions toggled by phase % 4
    const ph = phase % 4;
    const wheels = [
      { x: CAR_X + 50,         y: CAR_Y + CAR_H + 4 },
      { x: CAR_X + CAR_W - 50, y: CAR_Y + CAR_H + 4 },
    ];
    wheels.forEach(w => {
      // tire (always)
      seg(true, c => { c.arc(w.x, w.y, 22, 0, Math.PI * 2); });
      // hub fill (lcd bg) — fake by drawing a slightly smaller ghost ring
      seg(false, c => { c.arc(w.x, w.y, 16, 0, Math.PI * 2); });
      // spokes — 4 orientations, draw all as ghost, light the one matching phase
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI; // 0, 45, 90, 135 deg
        const on = i === ph;
        segStroke(on, 4, c => {
          c.moveTo(w.x - Math.cos(a) * 14, w.y - Math.sin(a) * 14);
          c.lineTo(w.x + Math.cos(a) * 14, w.y + Math.sin(a) * 14);
        });
      }
      // hub cap dot
      seg(true, c => { c.arc(w.x, w.y, 3, 0, Math.PI * 2); });
    });
  }

  function drawAnimals(phase) {
    const f = phase & 1;          // 2-frame animation
    const f2 = (phase >> 1) & 1;  // slower 2-frame for arms

    // Side-view seat positions (right = front, left = back).
    // Sit each animal so its feet are around the door line (DOOR_Y).
    const seatY = CAR_Y - 5;

    // back-left: RACCOON (waving)
    drawRaccoon(CAR_X + 75, seatY, f2);
    // back-right: PARROT
    drawParrot(CAR_X + 130, seatY, f);
    // front-left (passenger): CAT
    drawCat(CAR_X + 185, seatY, f);
    // front-right (driver): DOG
    drawDog(CAR_X + 230, seatY, f);
  }

  // All animals share a torso + head + ears/feathers idiom. Coords are
  // anchored at (x, y) = top of the head.

  function drawDog(x, y, f) {
    // torso (visible above door)
    seg(true, c => { c.ellipse(x, y + 28, 14, 18, 0, 0, Math.PI * 2); });
    // head
    seg(true, c => { c.ellipse(x + 2, y + 8, 13, 11, 0, 0, Math.PI * 2); });
    // snout
    seg(true, c => { c.ellipse(x + 13, y + 12, 7, 5, 0, 0, Math.PI * 2); });
    // tongue lolling (always)
    seg(true, c => { c.ellipse(x + 16, y + 16, 3, 3, 0, 0, Math.PI * 2); });
    // ear: 2 frames — perked up vs flapping back from the wind
    seg(f === 0, c => {
      c.moveTo(x - 4, y + 4); c.lineTo(x - 6, y - 8); c.lineTo(x + 2, y + 2);
    });
    seg(f === 1, c => {
      c.moveTo(x - 4, y + 4); c.lineTo(x - 18, y + 2); c.lineTo(x - 2, y + 8);
    });
    // collar
    segStroke(true, 2, c => {
      c.moveTo(x - 10, y + 18); c.lineTo(x + 10, y + 18);
    });
    // collar tag
    seg(true, c => { c.arc(x, y + 22, 2, 0, Math.PI * 2); });
    // paws on the wheel (always, both frames)
    seg(true, c => { c.arc(x + 11, y + 26, 3, 0, Math.PI * 2); });
    seg(true, c => { c.arc(x + 14, y + 22, 3, 0, Math.PI * 2); });
    // eye
    seg(true, c => { c.arc(x + 5, y + 6, 1.6, 0, Math.PI * 2); });
  }

  function drawCat(x, y, f) {
    // torso
    seg(true, c => { c.ellipse(x, y + 28, 12, 18, 0, 0, Math.PI * 2); });
    // head
    seg(true, c => { c.ellipse(x, y + 8, 12, 11, 0, 0, Math.PI * 2); });
    // ears (triangles, always)
    seg(true, c => {
      c.moveTo(x - 10, y + 2); c.lineTo(x - 6, y - 8); c.lineTo(x - 2, y + 2);
    });
    seg(true, c => {
      c.moveTo(x + 2, y + 2); c.lineTo(x + 6, y - 8); c.lineTo(x + 10, y + 2);
    });
    // whiskers — toggle direction
    segStroke(f === 0, 1.2, c => { c.moveTo(x + 7, y + 9); c.lineTo(x + 18, y + 6); });
    segStroke(f === 0, 1.2, c => { c.moveTo(x + 7, y + 11); c.lineTo(x + 18, y + 13); });
    segStroke(f === 1, 1.2, c => { c.moveTo(x + 7, y + 9); c.lineTo(x + 18, y + 13); });
    segStroke(f === 1, 1.2, c => { c.moveTo(x + 7, y + 11); c.lineTo(x + 18, y + 6); });
    // tail flicking up over the seat — 2 frames
    segStroke(f === 0, 4, c => {
      c.moveTo(x - 6, y + 30); c.quadraticCurveTo(x - 24, y + 14, x - 16, y - 4);
    });
    segStroke(f === 1, 4, c => {
      c.moveTo(x - 6, y + 30); c.quadraticCurveTo(x - 24, y + 22, x - 22, y + 4);
    });
    // eyes
    seg(true, c => { c.arc(x - 4, y + 8, 1.6, 0, Math.PI * 2); c.arc(x + 4, y + 8, 1.6, 0, Math.PI * 2); });
    // nose
    seg(true, c => { c.arc(x, y + 12, 1.4, 0, Math.PI * 2); });
  }

  function drawParrot(x, y, f) {
    // torso
    seg(true, c => { c.ellipse(x, y + 22, 11, 18, 0, 0, Math.PI * 2); });
    // head
    seg(true, c => { c.ellipse(x, y + 6, 9, 9, 0, 0, Math.PI * 2); });
    // beak hooking forward (right)
    seg(true, c => {
      c.moveTo(x + 7, y + 4); c.lineTo(x + 16, y + 8); c.lineTo(x + 7, y + 10);
    });
    // crest feathers — 2 frames
    seg(f === 0, c => {
      c.moveTo(x - 3, y - 4); c.lineTo(x + 1, y - 16); c.lineTo(x + 5, y - 4);
    });
    seg(f === 1, c => {
      c.moveTo(x - 6, y - 4); c.lineTo(x - 4, y - 16); c.lineTo(x + 2, y - 4);
    });
    // wing flap — large silhouette over torso
    seg(f === 0, c => {
      c.ellipse(x - 6, y + 18, 6, 12, -0.3, 0, Math.PI * 2);
    });
    seg(f === 1, c => {
      c.ellipse(x - 4, y + 8, 6, 14, 0.5, 0, Math.PI * 2);
    });
    // eye
    seg(true, c => { c.arc(x + 4, y + 4, 1.4, 0, Math.PI * 2); });
    // foot peeking over door
    seg(true, c => {
      c.rect(x - 2, y + 36, 2, 4);
      c.rect(x + 2, y + 36, 2, 4);
    });
  }

  function drawRaccoon(x, y, f) {
    // torso
    seg(true, c => { c.ellipse(x, y + 26, 13, 16, 0, 0, Math.PI * 2); });
    // head
    seg(true, c => { c.ellipse(x, y + 8, 12, 10, 0, 0, Math.PI * 2); });
    // mask stripe across eyes
    seg(true, c => { c.rect(x - 9, y + 5, 18, 4); });
    // ears
    seg(true, c => { c.arc(x - 7, y - 1, 3, 0, Math.PI * 2); });
    seg(true, c => { c.arc(x + 7, y - 1, 3, 0, Math.PI * 2); });
    // arm waving high — 2 frames (above the head, very visible)
    segStroke(f === 0, 4, c => {
      c.moveTo(x + 4, y + 22); c.lineTo(x + 16, y - 10);
    });
    segStroke(f === 1, 4, c => {
      c.moveTo(x + 4, y + 22); c.lineTo(x + 22, y + 4);
    });
    // paw at tip of arm
    seg(f === 0, c => { c.arc(x + 16, y - 10, 3, 0, Math.PI * 2); });
    seg(f === 1, c => { c.arc(x + 22, y + 4, 3, 0, Math.PI * 2); });
    // striped tail held aloft — 2 frames
    segStroke(f === 0, 5, c => {
      c.moveTo(x - 8, y + 30); c.quadraticCurveTo(x - 26, y + 18, x - 22, y + 0);
    });
    segStroke(f === 1, 5, c => {
      c.moveTo(x - 8, y + 30); c.quadraticCurveTo(x - 30, y + 24, x - 28, y + 8);
    });
    // tail rings (2 short cross-strokes for a striped look)
    segStroke(true, 2, c => {
      c.moveTo(x - 18, y + 18); c.lineTo(x - 14, y + 22);
    });
    segStroke(true, 2, c => {
      c.moveTo(x - 24, y + 10); c.lineTo(x - 20, y + 14);
    });
    // eyes (peeking through the mask)
    seg(true, c => { c.arc(x - 4, y + 7, 1.4, 0, Math.PI * 2); c.arc(x + 4, y + 7, 1.4, 0, Math.PI * 2); });
    // snout
    seg(true, c => { c.ellipse(x, y + 12, 4, 3, 0, 0, Math.PI * 2); });
  }

  function drawAntenna(phase) {
    // wifi antenna on the trunk — 3 wave arcs, lit progressively with phase.
    // (No roof on the convertible, so it's mounted at the back.)
    const ax = CAR_X + 25;
    const ay = DOOR_Y + 10;          // top of the trunk
    segStroke(true, 2, c => { c.moveTo(ax, ay); c.lineTo(ax, ay - 30); });
    seg(true, c => { c.arc(ax, ay - 30, 2, 0, Math.PI * 2); });
    for (let i = 0; i < 3; i++) {
      const on = ((phase + i) % 3) !== 0;
      const r = 6 + i * 6;
      segStroke(on, 2, c => {
        c.arc(ax + 6, ay - 30, r, -Math.PI / 2.2, Math.PI / 2.2);
      });
    }
  }

  function drawExhaust(phase) {
    // 3 puffs, scrolling backward
    const ex = CAR_X - 4;
    const ey = CAR_Y + CAR_H - 4;
    for (let i = 0; i < 3; i++) {
      const on = ((phase + i) % 3) === 0;
      seg(on, c => { c.arc(ex - 14 - i * 18, ey - i * 4, 6 + i * 2, 0, Math.PI * 2); });
    }
  }

  // ============================================================
  //  HUD overlay drawn on canvas
  // ============================================================
  function drawHud() {
    ctx.fillStyle = INK;
    ctx.font = "bold 14px Courier New, monospace";
    ctx.textBaseline = "top";
    ctx.fillText(`NET ${pad(sim.networks, 5)}`, 8, 8);
    ctx.fillText(`PKT ${pad(sim.packets, 7)}`, 8, 26);
    ctx.fillText(`MPH ${pad(Math.round(sim.speed), 3)}`, W - 110, 8);
    if (sim.gps_on) ctx.fillText("GPS", W - 110, 26);
    if (sim.monitor_on) ctx.fillText("MON", W - 60, 26);
  }

  function pad(n, w) { return String(n).padStart(w, "0"); }

  // ============================================================
  //  main render loop
  // ============================================================
  function render() {
    // clear LCD with the plate color (transparent so CSS bg shows through)
    ctx.clearRect(0, 0, W, H);
    drawSky(frame);
    drawRoadside(frame);
    drawRoad(frame);
    drawCar(frame);
    drawHud();
  }

  function loop(now) {
    const dtMs = 1000 / tickHz();
    if (now - lastTick >= dtMs) {
      frame = (frame + 1) | 0;
      lastTick = now;
    }
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ============================================================
  //  websocket — receive backend snapshots
  // ============================================================
  function connectWs() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    const ws = new WebSocket(url);
    ws.onmessage = (ev) => {
      try {
        const s = JSON.parse(ev.data);
        sim.speed = s.speed_mph || 0;
        sim.networks = s.networks_total || 0;
        sim.packets = s.packets_total || 0;
        sim.monitor_on = !!s.monitor_on;
        sim.pcap_on = !!s.pcap_on;
        sim.gps_on = !!(s.gps && s.gps.have_fix);
        sim.status = s.status || "";
        updateReadouts();
      } catch (e) { /* ignore */ }
    };
    ws.onclose = () => setTimeout(connectWs, 1500);
    ws.onerror = () => ws.close();
  }
  connectWs();

  // ============================================================
  //  readouts + overlay indicators
  // ============================================================
  const segNet = document.getElementById("seg-networks");
  const segPkt = document.getElementById("seg-packets");
  const segMph = document.getElementById("seg-speed");
  const statusEl = document.getElementById("status");
  const ovr = {
    net: document.querySelector('[data-on="net"]'),
    pcap: document.querySelector('[data-on="pcap"]'),
    mon: document.querySelector('[data-on="mon"]'),
    gps: document.querySelector('[data-on="gps"]'),
    lo: document.querySelector('[data-on="lo"]'),
    mid: document.querySelector('[data-on="mid"]'),
    hi: document.querySelector('[data-on="hi"]'),
    warn: document.querySelector('[data-on="warn"]'),
  };
  function updateReadouts() {
    segNet.textContent = pad(sim.networks, 6);
    segPkt.textContent = pad(sim.packets, 8);
    segMph.textContent = pad(Math.round(sim.speed), 3);
    statusEl.textContent = sim.status;
    ovr.net.dataset.active = sim.networks > 0 ? "1" : "0";
    ovr.pcap.dataset.active = sim.pcap_on ? "1" : "0";
    ovr.mon.dataset.active = sim.monitor_on ? "1" : "0";
    ovr.gps.dataset.active = sim.gps_on ? "1" : "0";
    ovr.lo.dataset.active = sim.speed > 5 ? "1" : "0";
    ovr.mid.dataset.active = sim.speed > 40 ? "1" : "0";
    ovr.hi.dataset.active = sim.speed > 100 ? "1" : "0";
    ovr.warn.dataset.active = sim.speed > 180 ? "1" : "0";
    btnMon.dataset.on = sim.monitor_on ? "1" : "0";
    btnMon.textContent = `MONITOR: ${sim.monitor_on ? "ON" : "OFF"}`;
  }

  // ============================================================
  //  monitor mode button
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
      updateReadouts();
    } catch (e) {
      btnMon.dataset.err = "1";
      statusEl.textContent = String(e);
    } finally {
      btnMon.disabled = false;
    }
  });

  // ============================================================
  //  GPS — host device geolocation
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
      btnGps.textContent = "GPS: UNAVAIL";
      return;
    }
    if (!window.isSecureContext) {
      // Browsers refuse Geolocation on insecure origins. Surface clearly
      // rather than failing silently.
      btnGps.dataset.err = "1";
      btnGps.textContent = "GPS: HTTPS REQ";
      statusEl.textContent = "Geolocation needs HTTPS. Use https://<host>:8443/ and accept the cert.";
      return;
    }
    if (gpsWatch !== null) {
      navigator.geolocation.clearWatch(gpsWatch);
      gpsWatch = null;
      btnGps.dataset.on = "0";
      btnGps.textContent = "GPS: OFF";
      return;
    }
    btnGps.textContent = "GPS: WAIT…";
    gpsWatch = navigator.geolocation.watchPosition(
      (pos) => {
        btnGps.dataset.on = "1";
        btnGps.dataset.err = "0";
        btnGps.textContent = "GPS: ON";
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
        btnGps.textContent = `GPS: ${gpsErrLabel(err)}`;
        statusEl.textContent = `gps error: ${err.message || err.code}`;
        gpsWatch = null;
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  });

  // ============================================================
  //  Settings panel — whitelist
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
  let pendingWl = new Set(); // bssids ticked in the UI

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
      .filter(n =>
        !q ||
        (n.ssid || "").toLowerCase().includes(q) ||
        (n.bssid || "").toLowerCase().includes(q)
      )
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
      statusEl.textContent = `whitelist saved (${j.whitelisted_count})`;
      await loadNetworks();
    } catch (e) {
      statusEl.textContent = `save failed: ${e}`;
    } finally {
      btnSaveWl.disabled = false;
    }
  });

  btnSettings.addEventListener("click", async () => {
    modal.hidden = false;
    await loadNetworks();
  });
  btnCloseSettings.addEventListener("click", () => { modal.hidden = true; });
  modal.addEventListener("click", (ev) => {
    if (ev.target === modal) modal.hidden = true;
  });
})();
