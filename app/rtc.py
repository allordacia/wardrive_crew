"""RTC sync — read the AIO v2 PCF85063A and set system time at startup.

The uConsole has no native RTC; while mobile/offline the system clock
drifts wildly between boots. The AIO v2 board adds a battery-backed
PCF85063A that the host kernel exposes as /dev/rtc0 once the i2c-rtc
overlay is loaded. `hwclock -s` pulls hardware time into the system
clock (one-shot; subsequent NTP fixes will keep going).

Opt-in via env: WARDRIVE_RTC_SYNC=1 (default off; harmless if no RTC).
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess

from .state import STATE


log = logging.getLogger("wardrive.rtc")


async def sync_rtc_at_startup() -> None:
    if os.environ.get("WARDRIVE_RTC_SYNC", "0") != "1":
        return
    if not shutil.which("hwclock"):
        log.info("rtc: hwclock not in PATH; skipping")
        return
    rtc_dev = None
    for cand in ("/dev/rtc0", "/dev/rtc"):
        if os.path.exists(cand):
            rtc_dev = cand
            break
    if rtc_dev is None:
        log.info("rtc: no /dev/rtc* present; skipping")
        return
    try:
        proc = await asyncio.create_subprocess_exec(
            "hwclock", "-s", "-f", rtc_dev,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        _, err = await asyncio.wait_for(proc.communicate(), timeout=5)
        if proc.returncode == 0:
            STATE.rtc_synced = True
            STATE.status_msg = f"rtc synced from {rtc_dev}"
            log.info("rtc: synced from %s", rtc_dev)
        else:
            log.warning("rtc: hwclock -s failed: %s", err.decode(errors="replace").strip())
    except Exception as e:  # noqa: BLE001
        log.warning("rtc: sync exception: %s", e)
