"""Server-side GPS — read NMEA off the AIO v2's GPS UART and feed STATE.gps.

This is the path used on the uConsole / Hackergadgets AIO v2 board: the
onboard GNSS module emits NMEA on /dev/ttyS0 (CM4) or /dev/ttyAMA0 (CM5)
at 9600 baud once the GPS power rail is enabled (via aiov2_ctl or pinctrl).
Configured via env vars:

  WARDRIVE_GPS_DEVICE  - serial device path (empty = disabled, browser fallback)
  WARDRIVE_GPS_BAUD    - default 9600

When the serial GPS is producing fixes the browser-Geolocation button
becomes unnecessary; the page just reads STATE.gps over the websocket.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Optional

try:
    import serial  # type: ignore
except ImportError:  # pragma: no cover
    serial = None  # type: ignore

from .state import STATE


log = logging.getLogger("wardrive.gps")

KNOTS_TO_MPS = 0.5144444


def _nmea_to_decimal(coord: str, hemisphere: str) -> Optional[float]:
    """ddmm.mmmm or dddmm.mmmm + N/S/E/W -> signed decimal degrees."""
    if not coord or not hemisphere:
        return None
    try:
        dot = coord.index(".")
        deg_len = dot - 2
        if deg_len < 1:
            return None
        deg = int(coord[:deg_len])
        minutes = float(coord[deg_len:])
        decimal = deg + minutes / 60.0
        if hemisphere in ("S", "W"):
            decimal = -decimal
        return decimal
    except (ValueError, IndexError):
        return None


def _checksum_ok(line: str) -> bool:
    if "*" not in line:
        return False
    body, _, checksum = line[1:].partition("*")
    try:
        expected = int(checksum.strip()[:2], 16)
    except ValueError:
        return False
    actual = 0
    for ch in body:
        actual ^= ord(ch)
    return actual == expected


def parse_nmea(line: str) -> Optional[dict]:
    """Parse a single NMEA sentence into {lat, lon, speed_mps?, accuracy_m?}.

    Recognized: $GxRMC (lat/lon/speed), $GxGGA (lat/lon + HDOP-derived
    accuracy). Returns None for unparseable / no-fix sentences.
    """
    if not line.startswith("$") or "*" not in line:
        return None
    if not _checksum_ok(line):
        return None
    body = line.split("*", 1)[0]
    parts = body.split(",")
    sentence = parts[0][3:] if len(parts[0]) >= 6 else ""

    if sentence == "RMC":
        # $GxRMC,time,A/V,lat,NS,lon,EW,speed_knots,track,date,...
        if len(parts) < 8 or parts[2] != "A":
            return None
        lat = _nmea_to_decimal(parts[3], parts[4])
        lon = _nmea_to_decimal(parts[5], parts[6])
        if lat is None or lon is None:
            return None
        try:
            speed_kn = float(parts[7]) if parts[7] else 0.0
        except ValueError:
            speed_kn = 0.0
        return {"lat": lat, "lon": lon, "speed_mps": speed_kn * KNOTS_TO_MPS}

    if sentence == "GGA":
        # $GxGGA,time,lat,NS,lon,EW,fix_quality,num_sats,hdop,alt,...
        if len(parts) < 9 or parts[6] in ("", "0"):
            return None
        lat = _nmea_to_decimal(parts[2], parts[3])
        lon = _nmea_to_decimal(parts[4], parts[5])
        if lat is None or lon is None:
            return None
        try:
            hdop = float(parts[8]) if parts[8] else 0.0
        except ValueError:
            hdop = 0.0
        try:
            sats = int(parts[7]) if parts[7] else 0
        except ValueError:
            sats = 0
        # rough accuracy: HDOP × ~5m typical (sufficient for the score formula).
        return {
            "lat": lat,
            "lon": lon,
            "accuracy_m": hdop * 5.0,
            "hdop": hdop,
            "sat_count": sats,
        }

    return None


async def gps_serial_loop() -> None:
    """Read NMEA from WARDRIVE_GPS_DEVICE forever. No-op if unconfigured."""
    device = os.environ.get("WARDRIVE_GPS_DEVICE", "").strip()
    if not device:
        return
    if serial is None:
        log.error("WARDRIVE_GPS_DEVICE=%s but pyserial not installed", device)
        return
    try:
        baud = int(os.environ.get("WARDRIVE_GPS_BAUD", "9600"))
    except ValueError:
        baud = 9600

    last_speed: Optional[float] = None

    while True:
        try:
            ser = serial.Serial(device, baudrate=baud, timeout=1)
        except Exception as e:  # noqa: BLE001
            log.warning("gps: can't open %s: %s — retrying in 5s", device, e)
            STATE.status_msg = f"gps: {device} unavailable"
            await asyncio.sleep(5)
            continue

        log.info("gps: reading NMEA from %s @ %d baud", device, baud)
        STATE.status_msg = f"gps: reading {device}"
        try:
            while True:
                try:
                    raw = await asyncio.to_thread(ser.readline)
                except Exception as e:  # noqa: BLE001
                    log.warning("gps read err: %s", e)
                    break
                if not raw:
                    continue
                try:
                    line = raw.decode("ascii", errors="ignore").strip()
                except Exception:  # noqa: BLE001
                    continue
                fix = parse_nmea(line)
                if fix is None:
                    continue
                if "speed_mps" in fix:
                    last_speed = fix["speed_mps"]
                STATE.gps.lat = fix["lat"]
                STATE.gps.lon = fix["lon"]
                if "accuracy_m" in fix:
                    STATE.gps.accuracy_m = fix["accuracy_m"]
                if "hdop" in fix:
                    STATE.gps.hdop = fix["hdop"]
                if "sat_count" in fix:
                    STATE.gps.sat_count = fix["sat_count"]
                if last_speed is not None:
                    STATE.gps.speed_mps = last_speed
                STATE.gps.ts = time.time()
                STATE.gps.have_fix = True
                STATE.gps.source = "serial"
        finally:
            try:
                ser.close()
            except Exception:  # noqa: BLE001
                pass
        await asyncio.sleep(2)
