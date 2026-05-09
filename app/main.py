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
from . import rtc as rtc_mod
from . import sdr as sdr_mod
from . import lora as lora_mod
from . import bluetooth as bt_mod
from .state import STATE


logging.basicConfig(
    level=os.environ.get("WARDRIVE_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("wardrive")


STATIC_DIR = Path(__file__).parent / "static"


def _check_aio_board() -> None:
    """Initial-setup verification for uConsole + Hackergadgets AIO board.

    Probes the prerequisites the host-side `scripts/uconsole-aio-setup.sh`
    is supposed to have established (UART freed for the GPS, GPS device
    node present, RTC node present, declared wifi iface present). Each
    failure becomes a WARNING in the log and a line on the operator
    terminal's status panel via STATE.status_msg. Non-fatal: the app
    still starts so the operator can see the diagnostics.
    """
    iface = (STATE.iface or "").strip()
    gps_dev = os.environ.get("WARDRIVE_GPS_DEVICE", "").strip()
    rtc_sync = os.environ.get("WARDRIVE_RTC_SYNC", "0") == "1"
    issues: list[str] = []

    # Wireless interface declared in env must actually exist.
    if iface and not Path(f"/sys/class/net/{iface}").exists():
        issues.append(f"wifi iface {iface!r} not present")

    # GPS UART (only required when the env var is set).
    if gps_dev:
        if not Path(gps_dev).exists():
            issues.append(f"GPS device {gps_dev!r} missing — run scripts/uconsole-aio-setup.sh")
        else:
            cmdline = Path("/boot/firmware/cmdline.txt")
            if not cmdline.exists():
                cmdline = Path("/boot/cmdline.txt")
            try:
                if cmdline.exists() and "console=serial0" in cmdline.read_text():
                    issues.append(
                        "kernel console is on serial0 — UART will fight us; "
                        "run scripts/uconsole-aio-setup.sh and reboot"
                    )
            except OSError:
                pass

    # RTC node — only when sync is requested.
    if rtc_sync and not Path("/dev/rtc0").exists():
        issues.append("RTC sync enabled but /dev/rtc0 missing — wire the AIO RTC")

    # Bluetooth — only when BT scanning is requested.
    if os.environ.get("WARDRIVE_BT_ENABLED", "0") == "1":
        dbus_sock = Path("/var/run/dbus/system_bus_socket")
        if not dbus_sock.exists():
            issues.append(
                "BT enabled but DBus system bus socket missing — "
                "mount /var/run/dbus into the container"
            )
        rfkill = Path("/sys/class/rfkill")
        if rfkill.exists():
            blocked = False
            try:
                for entry in rfkill.iterdir():
                    type_p = entry / "type"
                    soft_p = entry / "soft"
                    if type_p.exists() and type_p.read_text().strip() == "bluetooth":
                        if soft_p.exists() and soft_p.read_text().strip() == "1":
                            blocked = True
                            break
            except OSError:
                pass
            if blocked:
                issues.append("Bluetooth is rfkill soft-blocked — `rfkill unblock bluetooth`")

    if issues:
        msg = "AIO setup check: " + "; ".join(issues)
        log.warning(msg)
        STATE.status_msg = msg
    else:
        log.info("AIO setup check: ok (iface=%s gps=%s rtc=%s bt=%s)",
                 iface or "--", gps_dev or "--",
                 "on" if rtc_sync else "off",
                 "on" if os.environ.get("WARDRIVE_BT_ENABLED", "0") == "1" else "off")


def _list_wireless_ifaces() -> list[dict]:
    """Enumerate wireless network interfaces on the host.

    Reads /sys/class/net for type=1 (ARPHRD_ETHER) entries that also
    have a ``wireless/`` subdirectory — that's the kernel's reliable
    way to identify wifi devices without shelling out. Falls back to
    listing nothing if /sys isn't accessible (e.g. in odd CI envs).
    """
    out: list[dict] = []
    base = Path("/sys/class/net")
    if not base.exists():
        return out
    try:
        for entry in sorted(base.iterdir()):
            if (entry / "wireless").is_dir():
                operstate = ""
                try:
                    operstate = (entry / "operstate").read_text().strip()
                except OSError:
                    pass
                out.append({"name": entry.name, "operstate": operstate})
    except OSError:
        pass
    return out


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Boot order for picking the wifi iface:
    #   1. previously-saved selection in the SQLite settings table (so a
    #      runtime change in the CONFIG modal survives restarts)
    #   2. WARDRIVE_IFACE env var
    #   3. default "wlan1" (uConsole + AIO build assumption)
    saved_iface = STATE.get_setting("active_iface")
    if saved_iface:
        STATE.iface = saved_iface
    else:
        STATE.iface = os.environ.get("WARDRIVE_IFACE", "wlan1")
    log.info("starting wardrive_crew on iface=%s", STATE.iface)
    _check_aio_board()
    await rtc_mod.sync_rtc_at_startup()
    tasks = [
        asyncio.create_task(scanner.scan_loop(), name="scan_loop"),
        asyncio.create_task(scanner.decay_loop(), name="decay_loop"),
        asyncio.create_task(gps_serial.gps_serial_loop(), name="gps_serial"),
        asyncio.create_task(sdr_mod.sdr_loop(), name="sdr_loop"),
        asyncio.create_task(lora_mod.lora_loop(), name="lora_loop"),
        asyncio.create_task(bt_mod.bt_loop(), name="bt_loop"),
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
    # Server-side serial GPS wins over the browser if it has a recent fix.
    if STATE.gps.source == "serial" and (time.time() - STATE.gps.ts) < 10:
        return {"ok": True, "ignored": "serial gps active"}
    STATE.gps.lat = fix.lat
    STATE.gps.lon = fix.lon
    STATE.gps.speed_mps = float(fix.speed_mps or 0.0)
    STATE.gps.accuracy_m = float(fix.accuracy_m or 0.0)
    STATE.gps.ts = time.time()
    STATE.gps.have_fix = True
    STATE.gps.source = "browser"
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
        "lat, lon, whitelisted, targeted FROM networks ORDER BY last_seen DESC LIMIT ?",
        (max(1, min(limit, 5000)),),
    )
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    return JSONResponse(rows)


class NetworkFlagsIn(BaseModel):
    """Toggle per-BSSID flags from the operator terminal. Either field may
    be omitted to leave it unchanged."""
    whitelisted: bool | None = None
    targeted: bool | None = None


@app.put("/api/network/{bssid}")
def set_network_flags(bssid: str, body: NetworkFlagsIn) -> dict:
    bssid = (bssid or "").lower().strip()
    if not bssid:
        raise HTTPException(status_code=400, detail="bssid required")
    cur = STATE.db.execute("SELECT 1 FROM networks WHERE bssid=?", (bssid,))
    if cur.fetchone() is None:
        raise HTTPException(status_code=404, detail="bssid not found")
    if body.whitelisted is not None:
        STATE.set_whitelist(bssid, bool(body.whitelisted))
    if body.targeted is not None:
        STATE.set_target(bssid, bool(body.targeted))
    cur = STATE.db.execute(
        "SELECT whitelisted, targeted FROM networks WHERE bssid=?", (bssid,)
    )
    row = cur.fetchone()
    return {
        "ok": True,
        "bssid": bssid,
        "whitelisted": bool(row[0]),
        "targeted": bool(row[1]),
    }


@app.get("/api/iface")
def list_ifaces() -> dict:
    """List host wireless interfaces and the current selection."""
    ifaces = _list_wireless_ifaces()
    current = STATE.iface or ""
    # If the current iface is in env / saved settings but not actually
    # present, surface that so the picker can show it as missing.
    names = {i["name"] for i in ifaces}
    return {
        "current": current,
        "current_present": current in names,
        "interfaces": ifaces,
    }


class IfaceIn(BaseModel):
    iface: str


@app.put("/api/iface")
def set_iface(body: IfaceIn) -> dict:
    """Switch the active wifi interface. Refuses while monitor mode is
    on so we don't orphan the monitor iface."""
    name = (body.iface or "").strip()
    if not name or len(name) > 32 or "/" in name:
        raise HTTPException(status_code=400, detail="invalid interface name")
    if STATE.monitor_on:
        raise HTTPException(
            status_code=409,
            detail="disable monitor mode before switching interface",
        )
    available = {i["name"] for i in _list_wireless_ifaces()}
    if available and name not in available:
        raise HTTPException(
            status_code=404,
            detail=f"interface {name!r} not found among {sorted(available)}",
        )
    STATE.iface = name
    STATE.set_setting("active_iface", name)
    log.info("active iface switched to %s", name)
    return {"ok": True, "iface": name}


@app.get("/api/bt/devices")
def bt_devices(limit: int = 500) -> JSONResponse:
    cur = STATE.db.execute(
        "SELECT mac, name, rssi, manufacturer, first_seen, last_seen, "
        "lat, lon, whitelisted, targeted FROM bt_devices "
        "ORDER BY last_seen DESC LIMIT ?",
        (max(1, min(limit, 5000)),),
    )
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    return JSONResponse(rows)


class BtFlagsIn(BaseModel):
    """Toggle per-device flags from the operator terminal. Either field
    may be omitted to leave it unchanged."""
    whitelisted: bool | None = None
    targeted: bool | None = None


@app.put("/api/bt/{mac}")
def set_bt_flags(mac: str, body: BtFlagsIn) -> dict:
    mac = (mac or "").lower().strip()
    if not mac:
        raise HTTPException(status_code=400, detail="mac required")
    cur = STATE.db.execute("SELECT 1 FROM bt_devices WHERE mac=?", (mac,))
    if cur.fetchone() is None:
        raise HTTPException(status_code=404, detail="mac not found")
    if body.whitelisted is not None:
        STATE.set_bt_whitelist(mac, bool(body.whitelisted))
    if body.targeted is not None:
        STATE.set_bt_target(mac, bool(body.targeted))
    cur = STATE.db.execute(
        "SELECT whitelisted, targeted FROM bt_devices WHERE mac=?", (mac,)
    )
    row = cur.fetchone()
    return {
        "ok": True,
        "mac": mac,
        "whitelisted": bool(row[0]),
        "targeted": bool(row[1]),
    }


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
    now = time.time()

    def _age(ts: float) -> float | None:
        return round(now - ts, 1) if ts else None

    return {
        "iface": STATE.iface,
        "monitor_iface": STATE.monitor_iface,
        "monitor_on": STATE.monitor_on,
        "pcap_on": STATE.pcap_on,
        "networks_total": STATE.total_networks(),
        "targets_total": STATE.total_targets(),
        "visible_nets": STATE.visible_networks(limit=24),
        "packets_total": STATE.total_packets(),
        "pcap_bytes_total": STATE.total_pcap_bytes(),
        "rf_signals_total": STATE.rf_signals_total,
        "speed_mph": round(STATE.speed_mph(), 1),
        "new_window": round(STATE.new_bssids_window, 2),
        "pkt_window": round(STATE.packets_window, 2),
        "rf_window": round(STATE.rf_signals_window, 2),
        # Per-radio operational detail for the radio status panel
        "wifi": {
            "iface": STATE.iface,
            "monitor_iface": STATE.monitor_iface,
            "monitor_on": STATE.monitor_on,
            "pcap_on": STATE.pcap_on,
            "last_scan_seen": STATE.last_scan_seen,
            "last_scan_new": STATE.last_scan_new,
            "last_scan_age_s": _age(STATE.last_scan_ts),
            "pcap_bytes_rate_s": round(STATE.pcap_bytes_rate_s, 1),
        },
        "rtc": {
            "synced": STATE.rtc_synced,
            "device": STATE.rtc_device,
            "synced_age_s": _age(STATE.rtc_synced_ts),
        },
        "sdr": {
            "active": STATE.sdr_active,
            "bands_count": STATE.sdr_bands_count,
            "last_band": STATE.sdr_last_band,
            "last_peaks": STATE.sdr_last_peaks,
            "last_age_s": _age(STATE.sdr_last_ts),
        },
        "lora": {
            "active": STATE.lora_active,
            "device": STATE.lora_device,
            "tx_count": STATE.lora_tx_count,
            "rx_count": STATE.lora_rx_count,
            "tx_age_s": _age(STATE.lora_last_tx_ts),
            "rx_age_s": _age(STATE.lora_last_rx_ts),
        },
        "bt": {
            "active": STATE.bt_active,
            "adapter": STATE.bt_adapter,
            "last_scan_age_s": _age(STATE.bt_last_scan_ts),
            "last_scan_new": STATE.bt_last_scan_new,
            "last_scan_seen": STATE.bt_last_scan_seen,
            "devices_total": STATE.bt_devices_total(),
            "targets_total": STATE.bt_targets_total(),
        },
        "bt_active": STATE.bt_active,
        "bt_devices_total": STATE.bt_devices_total(),
        "bt_targets_total": STATE.bt_targets_total(),
        "bt_visible": STATE.visible_bt_devices(limit=24),
        "bt_trackers": STATE.bt_trackers_seen(),
        "rtc_synced": STATE.rtc_synced,
        "sdr_active": STATE.sdr_active,
        "lora_active": STATE.lora_active,
        "crew_id": STATE.crew_id,
        "fleet": [
            {
                "crew_id": cid,
                "score": b.get("score", 0),
                "mph": b.get("mph", 0),
                "lat": b.get("lat"),
                "lon": b.get("lon"),
                "age_s": round((now - b.get("last_seen", 0)), 1),
            }
            for cid, b in STATE.fleet.items()
        ],
        "gps": {
            "have_fix": STATE.gps.have_fix,
            "lat": STATE.gps.lat,
            "lon": STATE.gps.lon,
            "speed_mps": STATE.gps.speed_mps,
            "accuracy_m": STATE.gps.accuracy_m,
            "hdop": STATE.gps.hdop,
            "sat_count": STATE.gps.sat_count,
            "sats_tracked": STATE.gps.sats_tracked,
            "nmea_frames": STATE.gps.nmea_frames,
            "nmea_age_s": _age(STATE.gps.nmea_last_ts),
            "source": STATE.gps.source,
            "age_s": (now - STATE.gps.ts) if STATE.gps.have_fix else None,
        },
        "bands": STATE.bssid_counts_by_band(),
        "status": STATE.status_msg,
        "ts": time.time(),
    }
