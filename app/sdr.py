"""Optional RTL-SDR sweep — passive RF activity counter.

When the AIO v2's RTL-SDR (RTL2832U + R860, 100 kHz – 1.74 GHz) is
available we periodically run `rtl_power` over a list of bands and
count how many FFT bins exceed a noise-floor threshold. That count
feeds STATE.rf_signals_window which the score formula picks up — i.e.
ambient RF activity makes the car go faster, same as new BSSIDs do.

Defaults are tuned for war-driving / passive scanning of common ISM
and avionics bands. Override via env:

  WARDRIVE_SDR_ENABLED   - set to 1 to run the loop (default 0)
  WARDRIVE_SDR_BANDS     - comma list, rtl_power -f syntax (e.g. "433M:435M")
  WARDRIVE_SDR_INTERVAL  - seconds between sweep cycles (default 60)
  WARDRIVE_SDR_THRESHOLD - dBm threshold for "peak" bins (default -40)
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from typing import Iterable

from .state import STATE


log = logging.getLogger("wardrive.sdr")


# ISM 433 (EU/global short-range), 868 (EU LoRa), 915 (US ISM/LoRa), ADS-B 1090
DEFAULT_BANDS = [
    "433.0M:434.8M",
    "868.0M:870.0M",
    "902.0M:928.0M",
    "1090.0M:1090.5M",
]


def _count_peaks(rtl_power_csv: str, threshold_dbm: float) -> int:
    """Count FFT bins above threshold across all rows of an rtl_power CSV.
    rtl_power CSV: date, time, low_hz, high_hz, step_hz, samples, dbm…"""
    peaks = 0
    for line in rtl_power_csv.splitlines():
        if not line or line.startswith("#"):
            continue
        cols = line.split(",")
        if len(cols) < 7:
            continue
        for v in cols[6:]:
            v = v.strip()
            if not v:
                continue
            try:
                if float(v) > threshold_dbm:
                    peaks += 1
            except ValueError:
                continue
    return peaks


async def _sweep_band(band: str, threshold_dbm: float) -> int:
    cmd = ["rtl_power", "-f", band, "-b", "10k", "-i", "5", "-1", "-q", "-"]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
    except asyncio.TimeoutError:
        log.warning("sdr: timeout sweeping %s", band)
        return 0
    except FileNotFoundError:
        return 0
    if proc.returncode != 0:
        return 0
    return _count_peaks(stdout.decode("ascii", errors="ignore"), threshold_dbm)


async def sdr_loop() -> None:
    if os.environ.get("WARDRIVE_SDR_ENABLED", "0") != "1":
        return
    if not shutil.which("rtl_power"):
        log.warning("sdr: rtl_power not installed; loop disabled")
        return

    bands_env = os.environ.get("WARDRIVE_SDR_BANDS", "").strip()
    bands: Iterable[str] = (
        [b.strip() for b in bands_env.split(",") if b.strip()]
        if bands_env else DEFAULT_BANDS
    )
    interval = int(os.environ.get("WARDRIVE_SDR_INTERVAL", "60"))
    threshold = float(os.environ.get("WARDRIVE_SDR_THRESHOLD", "-40"))

    bands_list = list(bands)
    STATE.sdr_active = True
    STATE.sdr_bands_count = len(bands_list)
    log.info("sdr: enabled, bands=%s every %ds, threshold=%.1f dBm",
             bands_list, interval, threshold)
    import time as _t
    while True:
        total = 0
        for band in bands_list:
            n = await _sweep_band(band, threshold)
            total += n
            STATE.sdr_last_band = band
            STATE.sdr_last_peaks = n
            STATE.sdr_last_ts = _t.time()
            if n > 0:
                log.debug("sdr %s: %d peaks", band, n)
        if total > 0:
            STATE.add_rf_signals(total)
            STATE.status_msg = f"sdr: {total} peaks across {len(bands_list)} bands"
        await asyncio.sleep(interval)
