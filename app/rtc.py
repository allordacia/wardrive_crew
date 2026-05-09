"""RTC sync — read the AIO PCF85063A and surface its state at startup.

The uConsole + AIO board exposes a battery-backed PCF85063A. Once the
i2c-rtc overlay is loaded the kernel binds it as /dev/rtcN and pulls
the wallclock from the chip during boot, so the system time is already
correct by the time this container starts.

Inside Docker we may not have CAP_SYS_TIME (settimeofday) — so we don't
try to write the wallclock here. Instead we:

  1. Walk /sys/class/rtc/ and pick the PCF85063A node by name (so we
     prefer the battery-backed AIO chip over a SoC RTC if both exist).
  2. Read its current time (`hwclock -r -f <dev>` or directly via
     /sys/class/rtc/rtcN/date+time) — this only needs read access.
  3. If the read succeeds, mark STATE.rtc_synced and surface the device.

Opt-in via env: WARDRIVE_RTC_SYNC=1 (default off; harmless if no RTC).
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import time
from pathlib import Path

from .state import STATE


log = logging.getLogger("wardrive.rtc")


def _find_pcf_rtc() -> tuple[str, str] | None:
    """Walk /sys/class/rtc/ for the PCF85063A. Returns (/dev/rtcN, name)
    or None. Falls back to the first /dev/rtcN if no name match."""
    base = Path("/sys/class/rtc")
    if not base.exists():
        return None
    candidates: list[tuple[str, str, int]] = []  # (dev, name, priority)
    try:
        for entry in sorted(base.iterdir()):
            if not entry.name.startswith("rtc"):
                continue
            name = ""
            try:
                name = (entry / "name").read_text().strip()
            except OSError:
                pass
            dev = f"/dev/{entry.name}"
            if not Path(dev).exists():
                continue
            # Higher priority = preferred. PCF85063A wins outright.
            if "pcf85063" in name.lower():
                priority = 100
            elif "rtc" in name.lower() or "pcf" in name.lower():
                priority = 10
            else:
                priority = 1
            candidates.append((dev, name, priority))
    except OSError:
        return None
    if not candidates:
        return None
    candidates.sort(key=lambda c: c[2], reverse=True)
    return candidates[0][0], candidates[0][1]


async def _read_rtc(dev: str) -> bool:
    """Read the RTC clock via `hwclock -r`. Returns True on success.
    Read-only; doesn't need CAP_SYS_TIME so it works in unprivileged
    containers."""
    if not shutil.which("hwclock"):
        return False
    try:
        proc = await asyncio.create_subprocess_exec(
            "hwclock", "-r", "-f", dev,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=5)
        if proc.returncode == 0:
            log.info("rtc: %s reads %s", dev, out.decode(errors="replace").strip())
            return True
        log.warning("rtc: hwclock -r %s failed: %s",
                    dev, err.decode(errors="replace").strip())
        return False
    except Exception as e:  # noqa: BLE001
        log.warning("rtc: read exception on %s: %s", dev, e)
        return False


async def sync_rtc_at_startup() -> None:
    if os.environ.get("WARDRIVE_RTC_SYNC", "0") != "1":
        return
    found = _find_pcf_rtc()
    if found is None:
        log.info("rtc: no /dev/rtc* present; skipping")
        return
    dev, name = found
    if "pcf85063" not in name.lower() and name:
        log.info("rtc: using %s (%s) — not a PCF85063A; AIO RTC may be missing",
                 dev, name)

    if not await _read_rtc(dev):
        # Fall back: even if hwclock isn't usable we can still mark the
        # chip as present if the sysfs node exposes a date, since the
        # kernel itself drove the boot-time sync from this same device.
        date_p = Path(f"/sys/class/rtc/{Path(dev).name}/date")
        if date_p.exists():
            try:
                date_p.read_text()
                log.info("rtc: %s readable via sysfs (hwclock unusable in container)", dev)
            except OSError as e:
                log.warning("rtc: %s sysfs read failed: %s", dev, e)
                return
        else:
            return

    STATE.rtc_synced = True
    STATE.rtc_synced_ts = time.time()
    STATE.rtc_device = dev
    STATE.status_msg = f"rtc synced from {dev} ({name or 'rtc'})"
    log.info("rtc: synced from %s (%s)", dev, name or "unknown")
