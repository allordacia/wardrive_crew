/* WARDRIVE CREW — vehicle registry (16-bit renderer)
 *
 * Vehicles in the 16-bit renderer are drawn procedurally via simple
 * canvas rectangles + circles, since hand-painting a 110×32 chassis
 * as a sprite array is unwieldy. Animals remain as pixel-data because
 * personality matters there.
 *
 * Each vehicle declares:
 *   - size:           bounding box used for centering
 *   - seats:          how many animals fit; renderer fills in declaration
 *                     order from `assignments` (radio → animal id)
 *   - seatPositions:  top-left of each 14×20 animal sprite, in
 *                     vehicle-local coords (0,0 = vehicle top-left)
 *   - wheels:         circles to spin in sync with speedometer
 *   - antennas:       mount points for the WiFi/SDR/LoRa arcs
 *   - palette:        named CSS colors used by `draw(D, x, y, phase)`
 *   - draw(D, x, y, phase, sim): paints the chassis using D primitives
 *
 * Adding a new vehicle = add another entry; the renderer dispatches
 * through this registry by name.
 */
(() => {
  "use strict";

  const REG = {};

  // ------------------------------------------------------------------
  //  Recon Wagon — 6-seat open-top off-road truck. The default
  //  vehicle for the 16-bit renderer because it accommodates the
  //  full radio cast (WiFi/Pcap/GPS/SDR/LoRa/RTC).
  // ------------------------------------------------------------------
  REG.recon_wagon = {
    label: "Recon Wagon",
    size: { w: 120, h: 40 },
    seats: 6,
    seatPositions: [
      { x:   8, y: -10 },   // back-left
      { x:  24, y: -10 },
      { x:  40, y: -10 },
      { x:  56, y: -10 },
      { x:  72, y: -10 },
      { x:  92, y:  -8 },   // driver (slightly forward in cab)
    ],
    wheels: [
      { x: 20, y: 38, r: 7 },
      { x: 96, y: 38, r: 7 },
    ],
    antennas: [
      { x: 102, y: -10 },   // mast on cab roof
    ],
    palette: {
      body:    "#9a3018",
      bodyHi:  "#cc4020",
      bodyLo:  "#5a1810",
      window:  "#7a98c0",
      chrome:  "#c0c0d0",
      tire:    "#1a1a22",
      hub:     "#404048",
      light:   "#fff0a0",
    },
    draw(D, x, y, phase, sim) {
      const p = this.palette;
      // chassis lower box (doors / rocker panel)
      D.fillRect(x + 8,  y + 18, 100, 14, p.body);
      D.fillRect(x + 8,  y + 30, 100,  2, p.bodyLo);
      D.fillRect(x + 8,  y + 18, 100,  1, p.bodyHi);
      // open passenger area floor (slightly lighter)
      D.fillRect(x + 12, y + 14, 70,   4, p.bodyHi);
      // cab (front-right block, taller — driver compartment)
      D.fillRect(x + 80, y +  4, 22,  16, p.body);
      D.fillRect(x + 82, y +  6, 18,   8, p.window);    // windshield
      D.fillRect(x + 80, y +  4, 22,   1, p.bodyHi);
      // roll bars (3 inverted U's over the open back)
      [16, 38, 60].forEach(rx => {
        D.line(x + rx, y + 14, x + rx, y + 2, p.chrome);
        D.line(x + rx + 16, y + 14, x + rx + 16, y + 2, p.chrome);
        D.line(x + rx, y + 2, x + rx + 16, y + 2, p.chrome);
      });
      // headlight + taillight
      D.fillRect(x + 102, y + 22, 4, 4, p.light);
      D.fillRect(x +   8, y + 22, 4, 4, p.light);
      // door seams
      D.line(x + 80, y + 18, x + 80, y + 32, p.bodyLo);
      D.line(x + 40, y + 18, x + 40, y + 32, p.bodyLo);
      // bullbar
      D.line(x + 106, y + 20, x + 106, y + 30, p.chrome);
      D.line(x + 106, y + 22, x + 110, y + 22, p.chrome);
      D.line(x + 106, y + 28, x + 110, y + 28, p.chrome);
    },
  };

  // ------------------------------------------------------------------
  //  Compact Convertible — slimmer 4-seater for users who only have
  //  one or two radios active and want a more nimble look.
  // ------------------------------------------------------------------
  REG.convertible = {
    label: "Convertible",
    size: { w: 90, h: 36 },
    seats: 4,
    seatPositions: [
      { x: 10, y: -8 },
      { x: 26, y: -8 },
      { x: 44, y: -8 },
      { x: 62, y: -8 },
    ],
    wheels: [
      { x: 16, y: 34, r: 6 },
      { x: 74, y: 34, r: 6 },
    ],
    antennas: [
      { x:  8, y: 10 },  // antenna on the trunk
    ],
    palette: {
      body:    "#206080",
      bodyHi:  "#3088b0",
      bodyLo:  "#103048",
      window:  "#7a98c0",
      chrome:  "#d0d0e0",
      light:   "#fff0a0",
    },
    draw(D, x, y, phase, sim) {
      const p = this.palette;
      // hood + trunk
      D.fillRect(x +  4, y + 22, 12, 8, p.body);
      D.fillRect(x + 76, y + 22, 12, 8, p.body);
      // cabin lower
      D.fillRect(x + 10, y + 18, 72, 14, p.body);
      D.fillRect(x + 10, y + 30, 72,  2, p.bodyLo);
      D.fillRect(x + 10, y + 18, 72,  1, p.bodyHi);
      // slanted windshield + rear roll bar
      D.line(x + 70, y + 18, x + 78, y + 4, p.chrome);
      D.line(x + 16, y + 18, x + 16, y + 8, p.chrome);
      // door seam
      D.line(x + 46, y + 18, x + 46, y + 32, p.bodyLo);
      // headlight + taillight
      D.fillRect(x + 86, y + 24, 4, 3, p.light);
      D.fillRect(x +  4, y + 24, 4, 3, p.light);
    },
  };

  window.VEHICLE_SPRITES = REG;
})();
