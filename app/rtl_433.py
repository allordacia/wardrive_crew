"""RTL-SDR consumer-device decoder (rtl_433).

Spawns ``rtl_433 -F json`` against the same RTL-SDR dongle the rtl_power
loop would otherwise use, parses each emitted JSON record, and stores
the device in the ``rf_devices`` table. The operator terminal renders a
``RF.DEVICES`` tab that lists every consumer device rtl_433 has heard:
weather stations, tire-pressure sensors, garage doors, doorbells,
oil-tank monitors, livestock tags, irrigation controllers, etc.

This is mutually exclusive with ``app/sdr.py`` — both processes need
the dongle and won't share. ``app/main.py`` chooses which one to start
based on env at lifespan time:

  WARDRIVE_RTL433_ENABLED=1   -> run rtl_433_loop  (default in uConsole overlay)
  WARDRIVE_SDR_ENABLED=1      -> run rtl_power sweep

If both are 1, rtl_433 wins (it's strictly more useful — gives you
device decodes, not just bin-above-threshold counts).

Env tuning:
  WARDRIVE_RTL433_FREQ      single freq in Hz/k/M (e.g. 433.92M).
                            Empty = let rtl_433 use its default protocol
                            mix (433.92 MHz for the bulk of consumer
                            devices). Most users want this default.
  WARDRIVE_RTL433_GAIN      gain setting (default: auto)
  WARDRIVE_RTL433_DEVICE    SDR device index, default 0
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import time

from .state import STATE


log = logging.getLogger("wardrive.rtl433")


def _device_key(rec: dict) -> str:
    """Stable identifier for a decoded device. rtl_433 records that share
    a (model, id) pair are the same physical device emitting multiple
    packets; we dedupe by the combined key."""
    model = (rec.get("model") or "").strip() or "unknown"
    dev_id = rec.get("id")
    channel = rec.get("channel")
    subtype = rec.get("subtype")
    parts = [model]
    if dev_id is not None:
        parts.append(str(dev_id))
    elif channel is not None:
        parts.append(f"ch{channel}")
    if subtype is not None and dev_id is None:
        parts.append(f"sub{subtype}")
    return "|".join(parts)


def _summarise(rec: dict) -> str:
    """A short human-readable summary line — temperature, humidity, etc.
    Surfaced as the rf_devices ``summary`` column so the UI doesn't have
    to parse the raw JSON to show useful info."""
    bits = []
    for key in ("temperature_C", "temperature_F", "humidity",
                "pressure_kPa", "pressure_hPa", "pressure_PSI",
                "battery_ok", "wind_avg_km_h", "wind_avg_m_s",
                "wind_max_km_h", "rain_mm", "moisture",
                "tire_pressure_kPa", "depth_cm"):
        if key in rec and rec[key] not in (None, ""):
            label = key.split("_")[0]
            bits.append(f"{label}={rec[key]}")
            if len(bits) >= 4:
                break
    return " ".join(bits)


async def rtl_433_loop() -> None:
    """Long-running rtl_433 reader. No-op when disabled."""
    if os.environ.get("WARDRIVE_RTL433_ENABLED", "0") != "1":
        log.info("rtl_433: disabled (set WARDRIVE_RTL433_ENABLED=1 to enable)")
        return
    if not shutil.which("rtl_433"):
        log.warning("rtl_433: binary not in PATH; loop disabled")
        return

    freq    = os.environ.get("WARDRIVE_RTL433_FREQ", "").strip()
    gain    = os.environ.get("WARDRIVE_RTL433_GAIN", "").strip()
    device  = os.environ.get("WARDRIVE_RTL433_DEVICE", "0").strip()

    args = ["rtl_433", "-F", "json", "-M", "level", "-M", "time:utc",
            "-d", device]
    if freq:
        args += ["-f", freq]
    if gain:
        args += ["-g", gain]

    STATE.rtl433_active = True
    STATE.rtl433_cmd = " ".join(args)
    log.info("rtl_433: starting %s", " ".join(args))

    while True:
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except Exception as e:  # noqa: BLE001
            STATE.rtl433_active = False
            STATE.status_msg = f"rtl_433: spawn failed: {e}"
            log.warning("rtl_433: spawn failed: %s; retrying in 10s", e)
            await asyncio.sleep(10)
            continue

        STATE.rtl433_active = True
        try:
            assert proc.stdout is not None
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                line_s = line.decode(errors="replace").strip()
                if not line_s or not line_s.startswith("{"):
                    continue
                try:
                    rec = json.loads(line_s)
                except json.JSONDecodeError:
                    continue
                _ingest(rec, line_s)
        except asyncio.CancelledError:
            log.info("rtl_433: cancelled")
            STATE.rtl433_active = False
            try:
                proc.kill()
                await proc.wait()
            except Exception:  # noqa: BLE001
                pass
            raise
        except Exception:  # noqa: BLE001
            log.exception("rtl_433: read loop error")

        STATE.rtl433_active = False
        rc = await proc.wait()
        log.warning("rtl_433: exited rc=%s; restarting in 5s", rc)
        await asyncio.sleep(5)


def _ingest(rec: dict, raw_line: str) -> None:
    """Push a single rtl_433 JSON record into the DB."""
    try:
        key = _device_key(rec)
        model = rec.get("model") or "unknown"
        dev_id = "" if rec.get("id") is None else str(rec.get("id"))
        channel = "" if rec.get("channel") is None else str(rec.get("channel"))
        freq = rec.get("freq") or rec.get("freq1") or 0.0
        try:
            freq_mhz = float(freq)
        except (TypeError, ValueError):
            freq_mhz = 0.0
        rssi = rec.get("rssi")
        try:
            rssi_i = int(rssi) if rssi is not None else None
        except (TypeError, ValueError):
            rssi_i = None
        STATE.add_rf_device(
            key=key,
            model=model,
            dev_id=dev_id,
            channel=channel,
            freq_mhz=freq_mhz,
            rssi=rssi_i,
            summary=_summarise(rec),
            raw=raw_line[:500],  # cap, single record
        )
        STATE.rtl433_last_ts = time.time()
    except Exception:  # noqa: BLE001
        log.exception("rtl_433: ingest failed")
