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
  //  REGISTRIES — Animals, Vehicles, Presets
  // ============================================================
  //
  // Adding new content is purely additive — no changes to the render
  // loop. Drop a new entry into one of these tables.
  //
  //   ANIMALS.<id> = {
  //     label,
  //     draw(x, y, frame)    // (x, y) = top-of-head; frame ∈ {0,1}
  //   }
  //
  //   VEHICLES.<id> = {
  //     label,
  //     width, height,         // hit-box for centering on the canvas
  //     seats,                 // max animals this vehicle can hold
  //     seatPositions(carX, carY) -> [{x, y}, …]
  //     draw(carX, carY, phase)
  //   }
  //
  //   PRESETS.<id> = {
  //     label,
  //     vehicle: <vehicle id>,
  //     cast: [<animal id>, …]   // length ≤ vehicle.seats
  //   }
  //
  // Inside draw fns, use the closure-scoped seg() / segStroke() / rrect()
  // helpers — same primitives the rest of the scene uses.

  const ANIMALS = {};
  const VEHICLES = {};
  const PRESETS = {};

  // ----- shared wheel renderer (all vehicles use it) ------------------
  function drawSpokedWheel(wx, wy, radius, phase) {
    const ph = phase % 4;
    seg(true, c => { c.arc(wx, wy, radius, 0, Math.PI * 2); });
    seg(false, c => { c.arc(wx, wy, radius - 6, 0, Math.PI * 2); });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI;
      const on = i === ph;
      segStroke(on, 4, c => {
        c.moveTo(wx - Math.cos(a) * (radius - 8), wy - Math.sin(a) * (radius - 8));
        c.lineTo(wx + Math.cos(a) * (radius - 8), wy + Math.sin(a) * (radius - 8));
      });
    }
    seg(true, c => { c.arc(wx, wy, 3, 0, Math.PI * 2); });
  }

  function drawWifiAntenna(ax, ay, phase) {
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

  function drawExhaust(ex, ey, phase) {
    for (let i = 0; i < 3; i++) {
      const on = ((phase + i) % 3) === 0;
      seg(on, c => { c.arc(ex - 14 - i * 18, ey - i * 4, 6 + i * 2, 0, Math.PI * 2); });
    }
  }

  // ============================================================
  //  ANIMALS — silhouettes anchored at (x, y) = top of head
  // ============================================================
  ANIMALS.dog = {
    label: "Driver Dog",
    draw(x, y, f) {
      seg(true, c => { c.ellipse(x, y + 28, 14, 18, 0, 0, Math.PI * 2); });
      seg(true, c => { c.ellipse(x + 2, y + 8, 13, 11, 0, 0, Math.PI * 2); });
      seg(true, c => { c.ellipse(x + 13, y + 12, 7, 5, 0, 0, Math.PI * 2); });
      seg(true, c => { c.ellipse(x + 16, y + 16, 3, 3, 0, 0, Math.PI * 2); });
      seg(f === 0, c => {
        c.moveTo(x - 4, y + 4); c.lineTo(x - 6, y - 8); c.lineTo(x + 2, y + 2);
      });
      seg(f === 1, c => {
        c.moveTo(x - 4, y + 4); c.lineTo(x - 18, y + 2); c.lineTo(x - 2, y + 8);
      });
      segStroke(true, 2, c => { c.moveTo(x - 10, y + 18); c.lineTo(x + 10, y + 18); });
      seg(true, c => { c.arc(x, y + 22, 2, 0, Math.PI * 2); });
      seg(true, c => { c.arc(x + 11, y + 26, 3, 0, Math.PI * 2); });
      seg(true, c => { c.arc(x + 14, y + 22, 3, 0, Math.PI * 2); });
      seg(true, c => { c.arc(x + 5, y + 6, 1.6, 0, Math.PI * 2); });
    },
  };

  ANIMALS.cat = {
    label: "Backseat Cat",
    draw(x, y, f) {
      seg(true, c => { c.ellipse(x, y + 28, 12, 18, 0, 0, Math.PI * 2); });
      seg(true, c => { c.ellipse(x, y + 8, 12, 11, 0, 0, Math.PI * 2); });
      seg(true, c => {
        c.moveTo(x - 10, y + 2); c.lineTo(x - 6, y - 8); c.lineTo(x - 2, y + 2);
      });
      seg(true, c => {
        c.moveTo(x + 2, y + 2); c.lineTo(x + 6, y - 8); c.lineTo(x + 10, y + 2);
      });
      segStroke(f === 0, 1.2, c => { c.moveTo(x + 7, y + 9); c.lineTo(x + 18, y + 6); });
      segStroke(f === 0, 1.2, c => { c.moveTo(x + 7, y + 11); c.lineTo(x + 18, y + 13); });
      segStroke(f === 1, 1.2, c => { c.moveTo(x + 7, y + 9); c.lineTo(x + 18, y + 13); });
      segStroke(f === 1, 1.2, c => { c.moveTo(x + 7, y + 11); c.lineTo(x + 18, y + 6); });
      segStroke(f === 0, 4, c => {
        c.moveTo(x - 6, y + 30); c.quadraticCurveTo(x - 24, y + 14, x - 16, y - 4);
      });
      segStroke(f === 1, 4, c => {
        c.moveTo(x - 6, y + 30); c.quadraticCurveTo(x - 24, y + 22, x - 22, y + 4);
      });
      seg(true, c => { c.arc(x - 4, y + 8, 1.6, 0, Math.PI * 2); c.arc(x + 4, y + 8, 1.6, 0, Math.PI * 2); });
      seg(true, c => { c.arc(x, y + 12, 1.4, 0, Math.PI * 2); });
    },
  };

  ANIMALS.parrot = {
    label: "Tropical Parrot",
    draw(x, y, f) {
      seg(true, c => { c.ellipse(x, y + 22, 11, 18, 0, 0, Math.PI * 2); });
      seg(true, c => { c.ellipse(x, y + 6, 9, 9, 0, 0, Math.PI * 2); });
      seg(true, c => {
        c.moveTo(x + 7, y + 4); c.lineTo(x + 16, y + 8); c.lineTo(x + 7, y + 10);
      });
      seg(f === 0, c => {
        c.moveTo(x - 3, y - 4); c.lineTo(x + 1, y - 16); c.lineTo(x + 5, y - 4);
      });
      seg(f === 1, c => {
        c.moveTo(x - 6, y - 4); c.lineTo(x - 4, y - 16); c.lineTo(x + 2, y - 4);
      });
      seg(f === 0, c => { c.ellipse(x - 6, y + 18, 6, 12, -0.3, 0, Math.PI * 2); });
      seg(f === 1, c => { c.ellipse(x - 4, y + 8, 6, 14, 0.5, 0, Math.PI * 2); });
      seg(true, c => { c.arc(x + 4, y + 4, 1.4, 0, Math.PI * 2); });
      seg(true, c => { c.rect(x - 2, y + 36, 2, 4); c.rect(x + 2, y + 36, 2, 4); });
    },
  };

  ANIMALS.raccoon = {
    label: "Bandit Raccoon",
    draw(x, y, f) {
      seg(true, c => { c.ellipse(x, y + 26, 13, 16, 0, 0, Math.PI * 2); });
      seg(true, c => { c.ellipse(x, y + 8, 12, 10, 0, 0, Math.PI * 2); });
      seg(true, c => { c.rect(x - 9, y + 5, 18, 4); });
      seg(true, c => { c.arc(x - 7, y - 1, 3, 0, Math.PI * 2); });
      seg(true, c => { c.arc(x + 7, y - 1, 3, 0, Math.PI * 2); });
      segStroke(f === 0, 4, c => { c.moveTo(x + 4, y + 22); c.lineTo(x + 16, y - 10); });
      segStroke(f === 1, 4, c => { c.moveTo(x + 4, y + 22); c.lineTo(x + 22, y + 4); });
      seg(f === 0, c => { c.arc(x + 16, y - 10, 3, 0, Math.PI * 2); });
      seg(f === 1, c => { c.arc(x + 22, y + 4, 3, 0, Math.PI * 2); });
      segStroke(f === 0, 5, c => {
        c.moveTo(x - 8, y + 30); c.quadraticCurveTo(x - 26, y + 18, x - 22, y + 0);
      });
      segStroke(f === 1, 5, c => {
        c.moveTo(x - 8, y + 30); c.quadraticCurveTo(x - 30, y + 24, x - 28, y + 8);
      });
      segStroke(true, 2, c => { c.moveTo(x - 18, y + 18); c.lineTo(x - 14, y + 22); });
      segStroke(true, 2, c => { c.moveTo(x - 24, y + 10); c.lineTo(x - 20, y + 14); });
      seg(true, c => { c.arc(x - 4, y + 7, 1.4, 0, Math.PI * 2); c.arc(x + 4, y + 7, 1.4, 0, Math.PI * 2); });
      seg(true, c => { c.ellipse(x, y + 12, 4, 3, 0, 0, Math.PI * 2); });
    },
  };

  ANIMALS.fox = {
    label: "Sly Fox",
    draw(x, y, f) {
      // slim torso
      seg(true, c => { c.ellipse(x, y + 26, 11, 17, 0, 0, Math.PI * 2); });
      // head — pointier than dog
      seg(true, c => { c.ellipse(x, y + 8, 11, 10, 0, 0, Math.PI * 2); });
      // sharp snout
      seg(true, c => {
        c.moveTo(x + 8, y + 6); c.lineTo(x + 18, y + 11); c.lineTo(x + 8, y + 13);
      });
      // big triangular ears (always)
      seg(true, c => {
        c.moveTo(x - 9, y + 2); c.lineTo(x - 6, y - 12); c.lineTo(x + 1, y + 2);
      });
      seg(true, c => {
        c.moveTo(x + 1, y + 2); c.lineTo(x + 6, y - 12); c.lineTo(x + 9, y + 2);
      });
      // bushy tail — 2 frames, big silhouette
      seg(f === 0, c => {
        c.ellipse(x - 18, y + 18, 9, 14, -0.4, 0, Math.PI * 2);
      });
      seg(f === 1, c => {
        c.ellipse(x - 22, y + 24, 9, 14, 0.4, 0, Math.PI * 2);
      });
      // white tail tip — extra stroke that toggles between two positions
      segStroke(f === 0, 3, c => {
        c.moveTo(x - 26, y + 12); c.lineTo(x - 22, y + 8);
      });
      segStroke(f === 1, 3, c => {
        c.moveTo(x - 30, y + 20); c.lineTo(x - 28, y + 16);
      });
      // eye + nose
      seg(true, c => { c.arc(x + 4, y + 6, 1.6, 0, Math.PI * 2); });
      seg(true, c => { c.arc(x + 17, y + 9, 1.4, 0, Math.PI * 2); });
    },
  };

  // ============================================================
  //  VEHICLES — body, windows, wheels, antennas, exhaust
  // ============================================================
  VEHICLES.convertible = {
    label: "Convertible",
    width: 280,
    height: 90,
    seats: 4,
    seatPositions(carX, carY) {
      return [
        { x: carX + 75,  y: carY - 5 },   // back-left
        { x: carX + 130, y: carY - 5 },   // back-right
        { x: carX + 185, y: carY - 5 },   // front-passenger
        { x: carX + 230, y: carY - 5 },   // driver
      ];
    },
    draw(carX, carY, phase) {
      const W_ = 280, H_ = 90;
      const door = carY + 30;
      seg(true, c => { rrect(c, carX + W_ - 60, door + 10, 60, H_ - 40, 4); }); // hood
      seg(true, c => { rrect(c, carX, door + 10, 50, H_ - 40, 4); });           // trunk
      seg(true, c => { rrect(c, carX + 45, door, W_ - 105, H_ - 30, 4); });     // cabin
      segStroke(true, 3, c => {
        c.moveTo(carX + W_ - 60, door); c.lineTo(carX + W_ - 78, door - 26);    // windshield
      });
      segStroke(true, 3, c => {
        c.moveTo(carX + 45, door); c.lineTo(carX + 45, door - 18);              // rear roll bar
      });
      segStroke(true, 2, c => {
        c.moveTo(carX + W_ / 2 - 5, door + 4); c.lineTo(carX + W_ / 2 - 5, carY + H_);
      });
      seg(true, c => { c.arc(carX + 90, door + 22, 2, 0, Math.PI * 2); });
      seg(true, c => { c.arc(carX + W_ - 95, door + 22, 2, 0, Math.PI * 2); });
      seg(true, c => { c.arc(carX + W_ - 6, door + 28, 5, 0, Math.PI * 2); });
      seg(((phase >> 1) & 1) === 1, c => { c.arc(carX + 6, door + 28, 5, 0, Math.PI * 2); });
      segStroke(true, 2, c => {
        c.arc(carX + W_ - 75, door + 8, 6, -0.4, Math.PI + 0.4);                // steering wheel
      });
      drawSpokedWheel(carX + 50, carY + H_ + 4, 22, phase);
      drawSpokedWheel(carX + W_ - 50, carY + H_ + 4, 22, phase);
      drawWifiAntenna(carX + 25, door + 10, phase);
      drawExhaust(carX - 4, carY + H_ - 4, phase);
    },
  };

  VEHICLES.safari_truck = {
    label: "Safari Truck",
    width: 340,
    height: 100,
    seats: 5,
    seatPositions(carX, carY) {
      const seatY = carY - 5;
      return [
        { x: carX + 80,  y: seatY },
        { x: carX + 130, y: seatY },
        { x: carX + 180, y: seatY },
        { x: carX + 230, y: seatY },
        { x: carX + 285, y: seatY },
      ];
    },
    draw(carX, carY, phase) {
      const W_ = 340, H_ = 100;
      const door = carY + 35;
      // long hood up front
      seg(true, c => { rrect(c, carX + W_ - 70, door + 5, 70, H_ - 40, 3); });
      // bullbar
      segStroke(true, 4, c => {
        c.moveTo(carX + W_ - 4, door + 10);
        c.lineTo(carX + W_ - 4, door + H_ - 50);
      });
      segStroke(true, 3, c => {
        c.moveTo(carX + W_ - 12, door + 18);
        c.lineTo(carX + W_, door + 18);
      });
      segStroke(true, 3, c => {
        c.moveTo(carX + W_ - 12, door + 28);
        c.lineTo(carX + W_, door + 28);
      });
      // chassis (long)
      seg(true, c => { rrect(c, carX, door + 5, W_ - 70, H_ - 40, 3); });
      // open passenger area top — three roll-cage hoops, drawn as inverted U
      [110, 180, 250].forEach(off => {
        segStroke(true, 3, c => {
          c.moveTo(carX + off - 28, door);
          c.lineTo(carX + off - 28, door - 30);
          c.quadraticCurveTo(carX + off, door - 42, carX + off + 28, door - 30);
          c.lineTo(carX + off + 28, door);
        });
      });
      // cross-brace between hoops (always on)
      segStroke(true, 2, c => {
        c.moveTo(carX + 50, door - 28); c.lineTo(carX + W_ - 80, door - 28);
      });
      // rooftop antenna array on rear hoop (visible high)
      drawWifiAntenna(carX + 70, door - 28, phase);
      // headlights (stacked)
      seg(true, c => { c.arc(carX + W_ - 6, door + 14, 4, 0, Math.PI * 2); });
      seg(true, c => { c.arc(carX + W_ - 6, door + 26, 4, 0, Math.PI * 2); });
      // taillight blink
      seg(((phase >> 1) & 1) === 1, c => {
        c.arc(carX + 6, door + 14, 4, 0, Math.PI * 2);
      });
      // spare tire on the back
      seg(true, c => { c.arc(carX + 18, door + 30, 14, 0, Math.PI * 2); });
      seg(false, c => { c.arc(carX + 18, door + 30, 9, 0, Math.PI * 2); });
      seg(true, c => { c.arc(carX + 18, door + 30, 2, 0, Math.PI * 2); });
      // steering wheel hint in front
      segStroke(true, 2, c => {
        c.arc(carX + W_ - 95, door + 12, 6, -0.4, Math.PI + 0.4);
      });
      // beefier off-road wheels
      drawSpokedWheel(carX + 60, carY + H_ + 0, 26, phase);
      drawSpokedWheel(carX + W_ - 70, carY + H_ + 0, 26, phase);
      drawExhaust(carX - 4, carY + H_ - 8, phase);
    },
  };

  // ============================================================
  //  PRESETS — pick a vehicle + a cast
  // ============================================================
  PRESETS.classic = {
    label: "Classic Convertible Crew",
    vehicle: "convertible",
    cast: ["raccoon", "parrot", "cat", "dog"],
  };
  PRESETS.safari = {
    label: "Safari Squad",
    vehicle: "safari_truck",
    cast: ["fox", "raccoon", "parrot", "cat", "dog"],
  };
  PRESETS.lone_wolf = {
    label: "Lone Wolf (driver only)",
    vehicle: "convertible",
    cast: ["fox"],
  };

  // ============================================================
  //  active preset + persistence
  // ============================================================
  let activePresetId = "classic";

  async function loadActivePreset() {
    try {
      const r = await fetch("/api/preset");
      if (r.ok) {
        const j = await r.json();
        if (j && j.preset && PRESETS[j.preset]) activePresetId = j.preset;
      }
    } catch (e) { /* offline ok */ }
  }
  async function saveActivePreset(id) {
    if (!PRESETS[id]) return;
    activePresetId = id;
    try {
      await fetch("/api/preset", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset: id }),
      });
    } catch (e) { /* ok */ }
  }

  // ============================================================
  //  car dispatcher — uses active preset
  // ============================================================
  function drawCar(phase) {
    const preset = PRESETS[activePresetId] || PRESETS.classic;
    const veh = VEHICLES[preset.vehicle] || VEHICLES.convertible;
    const carX = Math.floor((W - veh.width) / 2);
    const carY = 170;
    veh.draw(carX, carY, phase);
    const seats = veh.seatPositions(carX, carY);
    preset.cast.forEach((id, i) => {
      const seat = seats[i];
      if (!seat) return;
      const animal = ANIMALS[id];
      if (!animal) return;
      // alternate frame phase between adjacent seats so animations stagger
      const f = (i & 1) ? ((phase >> 1) & 1) : (phase & 1);
      animal.draw(seat.x, seat.y, f);
    });
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

  // ============================================================
  //  Preset picker (vehicle + cast)
  // ============================================================
  const presetSelect = document.getElementById("preset-select");
  const presetInfo = document.getElementById("preset-info");

  function describePreset(id) {
    const p = PRESETS[id];
    if (!p) return "";
    const veh = VEHICLES[p.vehicle];
    const cast = p.cast.map(a => ANIMALS[a]?.label || a).join(", ");
    return `${veh ? veh.label : p.vehicle} · ${cast}`;
  }
  function populatePresetPicker() {
    if (!presetSelect) return;
    presetSelect.innerHTML = "";
    for (const [id, p] of Object.entries(PRESETS)) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = p.label;
      if (id === activePresetId) opt.selected = true;
      presetSelect.appendChild(opt);
    }
    presetInfo.textContent = describePreset(activePresetId);
  }
  if (presetSelect) {
    presetSelect.addEventListener("change", async (e) => {
      await saveActivePreset(e.target.value);
      presetInfo.textContent = describePreset(activePresetId);
    });
  }
  // load + render the picker once the page is ready
  loadActivePreset().then(populatePresetPicker);

  btnSettings.addEventListener("click", async () => {
    modal.hidden = false;
    populatePresetPicker();
    await loadNetworks();
  });
  btnCloseSettings.addEventListener("click", () => { modal.hidden = true; });
  modal.addEventListener("click", (ev) => {
    if (ev.target === modal) modal.hidden = true;
  });
})();
