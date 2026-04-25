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
  //  CAR — boxy hatchback, 4 critters hanging out
  // ============================================================
  const CAR_X = 180;
  const CAR_Y = 170;
  const CAR_W = 280;
  const CAR_H = 90;

  function drawCar(phase) {
    // body — always on
    seg(true, c => {
      // lower body
      rrect(c, CAR_X, CAR_Y + 30, CAR_W, CAR_H - 30, 6);
    });
    // upper greenhouse / roof
    seg(true, c => {
      c.moveTo(CAR_X + 30, CAR_Y + 30);
      c.lineTo(CAR_X + 60, CAR_Y);
      c.lineTo(CAR_X + CAR_W - 60, CAR_Y);
      c.lineTo(CAR_X + CAR_W - 20, CAR_Y + 30);
      c.lineTo(CAR_X + 30, CAR_Y + 30);
    });
    // window cutouts (we draw them by repainting LCD background color via composite)
    // Simpler: draw the windows as ghost rectangles to suggest glass.
    drawWindow(CAR_X + 65, CAR_Y + 6, 70, 22);   // driver
    drawWindow(CAR_X + 145, CAR_Y + 6, 70, 22);  // rear

    // door seams (always on, thin)
    segStroke(true, 2, c => {
      c.moveTo(CAR_X + 140, CAR_Y + 32);
      c.lineTo(CAR_X + 140, CAR_Y + CAR_H);
    });

    // headlight + taillight
    seg(true, c => { c.arc(CAR_X + CAR_W - 8, CAR_Y + 50, 5, 0, Math.PI * 2); });
    seg(((phase >> 1) & 1) === 1, c => {  // brake/signal blink
      c.arc(CAR_X + 8, CAR_Y + 50, 5, 0, Math.PI * 2);
    });

    drawWheels(phase);
    drawAnimals(phase);
    drawAntenna(phase);
    drawExhaust(phase);
  }

  function drawWindow(x, y, w, h) {
    // faint window outline so glass is suggested
    segStroke(true, 2, c => { c.rect(x, y, w, h); });
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
    const f = phase & 1;          // 2-frame body animation
    const f2 = (phase >> 1) & 1;  // slower 2-frame for arms

    // DRIVER DOG — head out front window
    drawDog(CAR_X + 92, CAR_Y + 10, f);

    // BACKSEAT CAT — rear window
    drawCat(CAR_X + 175, CAR_Y + 10, f);

    // SUNROOF PARROT — pops out of top
    drawParrot(CAR_X + 130, CAR_Y - 6, f2);

    // HATCHBACK RACCOON — hanging out the back
    drawRaccoon(CAR_X - 8, CAR_Y + 38, f2);
  }

  function drawDog(x, y, f) {
    // head
    seg(true, c => {
      c.ellipse(x, y, 14, 12, 0, 0, Math.PI * 2);
    });
    // snout
    seg(true, c => { c.ellipse(x + 12, y + 4, 7, 5, 0, 0, Math.PI * 2); });
    // ear flapping — frame 0 up, frame 1 back
    seg(f === 0, c => {
      c.moveTo(x - 6, y - 8); c.lineTo(x - 14, y - 22); c.lineTo(x - 2, y - 14);
    });
    seg(f === 1, c => {
      c.moveTo(x - 6, y - 8); c.lineTo(x - 22, y - 6); c.lineTo(x - 4, y - 2);
    });
    // tongue out always
    seg(true, c => { c.ellipse(x + 14, y + 8, 4, 3, 0, 0, Math.PI * 2); });
    // eye dot
    seg(true, c => { c.arc(x + 4, y - 2, 1.6, 0, Math.PI * 2); });
  }

  function drawCat(x, y, f) {
    // head
    seg(true, c => { c.ellipse(x, y + 2, 13, 11, 0, 0, Math.PI * 2); });
    // ears (triangles)
    seg(true, c => {
      c.moveTo(x - 10, y - 6); c.lineTo(x - 5, y - 16); c.lineTo(x - 2, y - 6);
    });
    seg(true, c => {
      c.moveTo(x + 2, y - 6); c.lineTo(x + 5, y - 16); c.lineTo(x + 10, y - 6);
    });
    // whiskers — toggle direction
    segStroke(f === 0, 1.5, c => { c.moveTo(x + 8, y + 2); c.lineTo(x + 22, y); });
    segStroke(f === 0, 1.5, c => { c.moveTo(x + 8, y + 5); c.lineTo(x + 22, y + 6); });
    segStroke(f === 1, 1.5, c => { c.moveTo(x + 8, y + 2); c.lineTo(x + 22, y + 6); });
    segStroke(f === 1, 1.5, c => { c.moveTo(x + 8, y + 5); c.lineTo(x + 22, y); });
    // eyes
    seg(true, c => { c.arc(x - 4, y, 1.6, 0, Math.PI * 2); c.arc(x + 4, y, 1.6, 0, Math.PI * 2); });
  }

  function drawParrot(x, y, f) {
    // body popping out of sunroof
    seg(true, c => { c.ellipse(x, y - 4, 9, 12, 0, 0, Math.PI * 2); });
    // beak
    seg(true, c => {
      c.moveTo(x + 7, y - 10); c.lineTo(x + 16, y - 6); c.lineTo(x + 7, y - 4);
    });
    // crest feathers — 2 frames
    seg(f === 0, c => {
      c.moveTo(x - 2, y - 14); c.lineTo(x + 2, y - 24); c.lineTo(x + 6, y - 14);
    });
    seg(f === 1, c => {
      c.moveTo(x - 6, y - 12); c.lineTo(x - 4, y - 24); c.lineTo(x + 0, y - 14);
    });
    // wing flap
    seg(f === 0, c => { c.ellipse(x - 8, y - 2, 4, 8, -0.4, 0, Math.PI * 2); });
    seg(f === 1, c => { c.ellipse(x - 6, y - 8, 4, 8, 0.6, 0, Math.PI * 2); });
    // eye
    seg(true, c => { c.arc(x + 3, y - 8, 1.4, 0, Math.PI * 2); });
  }

  function drawRaccoon(x, y, f) {
    // body hanging out the hatch
    seg(true, c => { c.ellipse(x, y, 12, 9, 0, 0, Math.PI * 2); });
    // mask stripe
    seg(true, c => { c.rect(x - 9, y - 3, 18, 4); });
    // ears
    seg(true, c => { c.arc(x - 7, y - 9, 3, 0, Math.PI * 2); });
    seg(true, c => { c.arc(x + 7, y - 9, 3, 0, Math.PI * 2); });
    // arm waving — 2 frames
    segStroke(f === 0, 3, c => { c.moveTo(x - 10, y + 4); c.lineTo(x - 22, y - 4); });
    segStroke(f === 1, 3, c => { c.moveTo(x - 10, y + 4); c.lineTo(x - 22, y + 12); });
    // striped tail
    segStroke(true, 4, c => { c.moveTo(x - 12, y + 6); c.lineTo(x - 26, y + 14); });
    // eyes
    seg(true, c => { c.arc(x - 3, y - 1, 1.4, 0, Math.PI * 2); c.arc(x + 3, y - 1, 1.4, 0, Math.PI * 2); });
  }

  function drawAntenna(phase) {
    // wifi antenna on roof — 3 wave arcs, lit progressively with phase
    const ax = CAR_X + CAR_W - 70;
    const ay = CAR_Y - 4;
    segStroke(true, 2, c => { c.moveTo(ax, ay); c.lineTo(ax, ay - 18); });
    seg(true, c => { c.arc(ax, ay - 18, 2, 0, Math.PI * 2); });
    for (let i = 0; i < 3; i++) {
      const on = ((phase + i) % 3) !== 0;
      const r = 6 + i * 6;
      segStroke(on, 2, c => {
        c.arc(ax + 6, ay - 18, r, -Math.PI / 2.2, Math.PI / 2.2);
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
  btnGps.addEventListener("click", () => {
    if (!("geolocation" in navigator)) {
      btnGps.dataset.err = "1";
      btnGps.textContent = "GPS: UNAVAIL";
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
        btnGps.textContent = `GPS: ${err.code === 1 ? "DENIED" : "ERR"}`;
        gpsWatch = null;
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  });
})();
