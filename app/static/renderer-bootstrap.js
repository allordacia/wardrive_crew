/* WARDRIVE CREW — renderer bootstrap
 *
 * Picks the active renderer at page load, wires the SETTINGS dropdown,
 * and swaps renderers without a page reload.
 *
 * Each renderer registers itself on `window.WardriveRenderer.<id>`
 * with `{ label, activate, deactivate }`. The activate function owns
 * its own websocket + animation frame loop. The deactivate function
 * tears them down so we never have two running concurrently.
 *
 * Persistence:
 *   - localStorage.renderer is read first (instant, no flash)
 *   - GET /api/renderer reconciles after, in case another tab/device
 *     changed the choice; the localStorage value takes precedence on
 *     this browser to avoid a switch flicker
 *   - PUT /api/renderer on every change so the choice survives
 *     `docker compose restart`
 */
(() => {
  "use strict";

  const ALLOWED = ["lcd", "sixteen"];

  function readLocal() {
    try {
      const v = localStorage.getItem("renderer");
      return ALLOWED.includes(v) ? v : null;
    } catch (e) {
      return null;
    }
  }
  function writeLocal(id) {
    try { localStorage.setItem("renderer", id); } catch (e) {}
  }
  async function readBackend() {
    try {
      const r = await fetch("/api/renderer");
      if (!r.ok) return null;
      const j = await r.json();
      return ALLOWED.includes(j.renderer) ? j.renderer : null;
    } catch (e) { return null; }
  }
  async function writeBackend(id) {
    try {
      await fetch("/api/renderer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ renderer: id }),
      });
    } catch (e) {}
  }

  let activeId = null;

  function getRenderer(id) {
    return window.WardriveRenderer && window.WardriveRenderer[id];
  }

  async function waitForRenderer(id, maxMs = 2000) {
    const start = performance.now();
    while (!getRenderer(id)) {
      if (performance.now() - start > maxMs) return null;
      await new Promise(r => setTimeout(r, 30));
    }
    return getRenderer(id);
  }

  async function switchTo(id) {
    if (!ALLOWED.includes(id)) return;
    if (activeId === id) return;
    const next = await waitForRenderer(id);
    if (!next) {
      console.warn(`renderer "${id}" never registered; staying on ${activeId}`);
      return;
    }
    if (activeId) {
      const prev = getRenderer(activeId);
      if (prev && typeof prev.deactivate === "function") {
        try { prev.deactivate(); } catch (e) { console.error("deactivate failed:", e); }
      }
    }
    document.body.dataset.activeRenderer = id;
    writeLocal(id);
    try {
      next.activate();
    } catch (e) {
      console.error(`activating "${id}" failed:`, e);
    }
    activeId = id;

    const sel = document.getElementById("renderer-select");
    if (sel && sel.value !== id) sel.value = id;

    // Don't await — background-persist so the dropdown stays snappy.
    writeBackend(id);
  }

  async function init() {
    const initial = readLocal() || "lcd";
    document.body.dataset.activeRenderer = initial;
    await switchTo(initial);

    // Reconcile with backend once we're up.
    const fromBackend = await readBackend();
    if (fromBackend && fromBackend !== activeId && !readLocal()) {
      // Only respect the backend value if the user hasn't expressed
      // a local preference yet.
      await switchTo(fromBackend);
    }

    const sel = document.getElementById("renderer-select");
    if (sel) {
      sel.value = activeId;
      sel.addEventListener("change", e => switchTo(e.target.value));
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
