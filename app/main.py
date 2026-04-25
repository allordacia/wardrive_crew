from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import scanner
from . import gps_serial
from .state import STATE


logging.basicConfig(
    level=os.environ.get("WARDRIVE_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("wardrive")


STATIC_DIR = Path(__file__).parent / "static"


def _autodetect_preset() -> None:
    """First-boot heuristic: if the AIO v2 hardware looks present and no
    preset has been chosen yet, pick the safari preset (themed for off-grid)
    so users running on a uConsole get a uConsole-flavoured scene by default.
    """
    if STATE.get_setting("scene_preset") is not None:
        return
    gps_dev = os.environ.get("WARDRIVE_GPS_DEVICE", "").strip()
    has_aio_gps = bool(gps_dev) and Path(gps_dev).exists()
    if has_aio_gps:
        STATE.set_setting("scene_preset", "safari")
        log.info("auto-selected 'safari' preset (AIO v2 GPS detected at %s)", gps_dev)


@asynccontextmanager
async def lifespan(app: FastAPI):
    STATE.iface = os.environ.get("WARDRIVE_IFACE", "wlan0")
    log.info("starting wardrive_crew on iface=%s", STATE.iface)
    _autodetect_preset()
    tasks = [
        asyncio.create_task(scanner.scan_loop(), name="scan_loop"),
        asyncio.create_task(scanner.decay_loop(), name="decay_loop"),
        asyncio.create_task(gps_serial.gps_serial_loop(), name="gps_serial"),
    ]
    if os.environ.get("WARDRIVE_AUTO_MONITOR", "0") == "1":
        try:
            await scanner.enable_monitor()
            await scanner.start_pcap()
        except Exception as e:  # noqa: BLE001
            log.error("auto monitor failed: %s", e)
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        await scanner.stop_pcap()
        if STATE.monitor_on:
            try:
                await scanner.disable_monitor()
            except Exception:  # noqa: BLE001
                pass


app = FastAPI(title="wardrive_crew", lifespan=lifespan)


# ---------------------------------------------------------------------------
# models
# ---------------------------------------------------------------------------

class GpsIn(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    speed_mps: float | None = Field(None, ge=0, le=400)
    accuracy_m: float | None = Field(None, ge=0)


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------

@app.get("/")
def root() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/api/status")
def status() -> dict:
    return _snapshot()


@app.post("/api/gps")
def gps(fix: GpsIn) -> dict:
    STATE.gps.lat = fix.lat
    STATE.gps.lon = fix.lon
    STATE.gps.speed_mps = float(fix.speed_mps or 0.0)
    STATE.gps.accuracy_m = float(fix.accuracy_m or 0.0)
    STATE.gps.ts = time.time()
    STATE.gps.have_fix = True
    return {"ok": True}


@app.post("/api/monitor/on")
async def monitor_on() -> dict:
    try:
        msg = await scanner.enable_monitor()
        await scanner.start_pcap()
    except Exception as e:  # noqa: BLE001
        log.exception("monitor on failed")
        STATE.status_msg = f"monitor on failed: {e}"
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "msg": msg, "monitor_on": STATE.monitor_on, "pcap_on": STATE.pcap_on}


@app.post("/api/monitor/off")
async def monitor_off() -> dict:
    try:
        msg = await scanner.disable_monitor()
    except Exception as e:  # noqa: BLE001
        log.exception("monitor off failed")
        STATE.status_msg = f"monitor off failed: {e}"
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "msg": msg, "monitor_on": STATE.monitor_on, "pcap_on": STATE.pcap_on}


@app.get("/api/networks")
def networks(limit: int = 500) -> JSONResponse:
    cur = STATE.db.execute(
        "SELECT bssid, ssid, channel, signal, encryption, first_seen, last_seen, "
        "lat, lon, whitelisted FROM networks ORDER BY last_seen DESC LIMIT ?",
        (max(1, min(limit, 5000)),),
    )
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    return JSONResponse(rows)


class WhitelistIn(BaseModel):
    bssid: str | None = None
    ssid: str | None = None
    whitelisted: bool


@app.post("/api/whitelist")
def whitelist(item: WhitelistIn) -> dict:
    """Toggle whitelist by BSSID (one row) or by SSID (every BSSID with that
    SSID). Whitelisted networks no longer count toward the score."""
    if item.bssid:
        ok = STATE.set_whitelist(item.bssid.lower(), item.whitelisted)
        if not ok:
            raise HTTPException(status_code=404, detail="bssid not found")
        return {"ok": True, "kind": "bssid", "value": item.bssid.lower()}
    if item.ssid is not None:
        n = STATE.whitelist_by_ssid(item.ssid, item.whitelisted)
        return {"ok": True, "kind": "ssid", "value": item.ssid, "rows": n}
    raise HTTPException(status_code=400, detail="provide bssid or ssid")


class WhitelistBulkIn(BaseModel):
    bssids: list[str] = Field(default_factory=list)
    ssids: list[str] = Field(default_factory=list)


class PresetIn(BaseModel):
    preset: str


@app.get("/api/preset")
def get_preset() -> dict:
    """Returns the active scene preset id (vehicle + cast). The frontend
    holds the registry of available presets; the backend just remembers
    which one was chosen so it survives container restarts."""
    return {"preset": STATE.get_setting("scene_preset", "classic")}


@app.put("/api/preset")
def set_preset(body: PresetIn) -> dict:
    if not body.preset or len(body.preset) > 64:
        raise HTTPException(status_code=400, detail="invalid preset id")
    STATE.set_setting("scene_preset", body.preset)
    return {"ok": True, "preset": body.preset}


@app.put("/api/whitelist")
def whitelist_set(body: WhitelistBulkIn) -> dict:
    """Replace the whitelist with the given BSSIDs (and any BSSID matching
    the given SSIDs). Anything not listed is un-whitelisted."""
    bssids = {b.lower() for b in body.bssids}
    ssids = set(body.ssids)
    STATE.db.execute("UPDATE networks SET whitelisted=0")
    if bssids:
        STATE.db.executemany(
            "UPDATE networks SET whitelisted=1 WHERE bssid=?",
            [(b,) for b in bssids],
        )
    if ssids:
        STATE.db.executemany(
            "UPDATE networks SET whitelisted=1 WHERE ssid=?",
            [(s,) for s in ssids],
        )
    STATE.db.commit()
    cur = STATE.db.execute("SELECT COUNT(*) FROM networks WHERE whitelisted=1")
    return {"ok": True, "whitelisted_count": int(cur.fetchone()[0])}


@app.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            await websocket.send_text(json.dumps(_snapshot()))
            await asyncio.sleep(0.25)
    except WebSocketDisconnect:
        return
    except Exception as e:  # noqa: BLE001
        log.warning("ws closed: %s", e)


def _snapshot() -> dict:
    return {
        "iface": STATE.iface,
        "monitor_iface": STATE.monitor_iface,
        "monitor_on": STATE.monitor_on,
        "pcap_on": STATE.pcap_on,
        "networks_total": STATE.total_networks(),
        "packets_total": STATE.total_packets(),
        "pcap_bytes_total": STATE.total_pcap_bytes(),
        "speed_mph": round(STATE.speed_mph(), 1),
        "new_window": round(STATE.new_bssids_window, 2),
        "pkt_window": round(STATE.packets_window, 2),
        "gps": {
            "have_fix": STATE.gps.have_fix,
            "lat": STATE.gps.lat,
            "lon": STATE.gps.lon,
            "speed_mps": STATE.gps.speed_mps,
            "accuracy_m": STATE.gps.accuracy_m,
            "age_s": (time.time() - STATE.gps.ts) if STATE.gps.have_fix else None,
        },
        "status": STATE.status_msg,
        "ts": time.time(),
    }
