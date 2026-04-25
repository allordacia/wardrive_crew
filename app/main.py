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
from .state import STATE


logging.basicConfig(
    level=os.environ.get("WARDRIVE_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("wardrive")


STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    STATE.iface = os.environ.get("WARDRIVE_IFACE", "wlan0")
    log.info("starting wardrive_crew on iface=%s", STATE.iface)
    tasks = [
        asyncio.create_task(scanner.scan_loop(), name="scan_loop"),
        asyncio.create_task(scanner.decay_loop(), name="decay_loop"),
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
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "msg": msg, "monitor_on": STATE.monitor_on, "pcap_on": STATE.pcap_on}


@app.post("/api/monitor/off")
async def monitor_off() -> dict:
    try:
        msg = await scanner.disable_monitor()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "msg": msg, "monitor_on": STATE.monitor_on, "pcap_on": STATE.pcap_on}


@app.get("/api/networks")
def networks(limit: int = 200) -> JSONResponse:
    cur = STATE.db.execute(
        "SELECT bssid, ssid, channel, signal, encryption, first_seen, last_seen, lat, lon "
        "FROM networks ORDER BY last_seen DESC LIMIT ?",
        (max(1, min(limit, 1000)),),
    )
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    return JSONResponse(rows)


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
