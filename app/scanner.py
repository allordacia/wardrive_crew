"""WiFi scanning + monitor-mode pcap capture.

Two engines:

* ``scan_loop``: periodically runs ``iw dev <iface> scan`` (works in managed
  mode, no root packet capture needed beyond NET_ADMIN). Counts unique
  BSSIDs.
* ``monitor_loop``: when monitor mode is enabled, flips the interface to
  monitor with ``iw`` and runs ``dumpcap`` (preferred) or ``tcpdump`` to
  rotate pcap files into ``/data/pcaps``. Periodically samples the file
  sizes/packet counts so the game can react.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Optional

from .state import DATA_DIR, STATE


log = logging.getLogger("wardrive.scanner")

PCAP_DIR = DATA_DIR / "pcaps"
SCAN_INTERVAL = float(os.environ.get("WARDRIVE_SCAN_INTERVAL", "8"))
MONITOR_SAMPLE_INTERVAL = 2.0


# ---------------------------------------------------------------------------
# parsing
# ---------------------------------------------------------------------------

_BSS_RE = re.compile(r"^BSS ([0-9a-f:]{17})", re.IGNORECASE)
_SSID_RE = re.compile(r"^\s*SSID:\s*(.*)$")
_FREQ_RE = re.compile(r"^\s*freq:\s*(\d+)")
_SIGNAL_RE = re.compile(r"^\s*signal:\s*(-?\d+\.\d+)")
_RSN_RE = re.compile(r"^\s*RSN:")
_WPA_RE = re.compile(r"^\s*WPA:")
_PRIVACY_RE = re.compile(r"capability:.*Privacy")


def _freq_to_channel(freq_mhz: int) -> Optional[int]:
    if 2412 <= freq_mhz <= 2484:
        if freq_mhz == 2484:
            return 14
        return (freq_mhz - 2407) // 5
    if 5000 <= freq_mhz <= 5900:
        return (freq_mhz - 5000) // 5
    if 5925 <= freq_mhz <= 7125:
        return (freq_mhz - 5950) // 5
    return None


def parse_iw_scan(text: str) -> list[dict]:
    """Parse the textual output of ``iw dev <iface> scan``."""
    networks: list[dict] = []
    cur: Optional[dict] = None
    for raw in text.splitlines():
        m = _BSS_RE.match(raw)
        if m:
            if cur is not None:
                networks.append(cur)
            cur = {
                "bssid": m.group(1).lower(),
                "ssid": "",
                "channel": None,
                "signal": None,
                "encryption": "open",
                "_has_rsn": False,
                "_has_wpa": False,
                "_has_privacy": False,
            }
            continue
        if cur is None:
            continue
        m = _SSID_RE.match(raw)
        if m:
            cur["ssid"] = m.group(1).strip()
            continue
        m = _FREQ_RE.match(raw)
        if m:
            cur["channel"] = _freq_to_channel(int(m.group(1)))
            continue
        m = _SIGNAL_RE.match(raw)
        if m:
            cur["signal"] = int(round(float(m.group(1))))
            continue
        if _RSN_RE.match(raw):
            cur["_has_rsn"] = True
            continue
        if _WPA_RE.match(raw):
            cur["_has_wpa"] = True
            continue
        if _PRIVACY_RE.search(raw):
            cur["_has_privacy"] = True

    if cur is not None:
        networks.append(cur)

    for n in networks:
        if n["_has_rsn"]:
            n["encryption"] = "WPA2/3"
        elif n["_has_wpa"]:
            n["encryption"] = "WPA"
        elif n["_has_privacy"]:
            n["encryption"] = "WEP"
        for k in ("_has_rsn", "_has_wpa", "_has_privacy"):
            n.pop(k, None)
    return networks


# ---------------------------------------------------------------------------
# subprocess helpers
# ---------------------------------------------------------------------------

async def _run(*cmd: str, timeout: float = 30.0) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, "", "timeout"
    return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


# ---------------------------------------------------------------------------
# scan loop
# ---------------------------------------------------------------------------

async def scan_loop() -> None:
    log.info("scan loop started on %s every %.1fs", STATE.iface, SCAN_INTERVAL)
    while True:
        await asyncio.sleep(SCAN_INTERVAL)
        if STATE.monitor_on:
            # iw scan doesn't work while in monitor mode; the monitor loop
            # is doing its own packet-driven discovery.
            continue
        try:
            rc, out, err = await _run("iw", "dev", STATE.iface, "scan", timeout=20)
        except FileNotFoundError:
            STATE.status_msg = "iw not installed"
            log.error("iw binary missing")
            await asyncio.sleep(10)
            continue
        if rc != 0:
            STATE.status_msg = f"scan err: {err.strip().splitlines()[-1] if err else rc}"
            continue
        nets = parse_iw_scan(out)
        new = 0
        for n in nets:
            if STATE.add_network(
                n["bssid"], n["ssid"], n["channel"], n["signal"], n["encryption"]
            ):
                new += 1
        STATE.last_scan_ts = time.time()
        STATE.status_msg = f"scan: {len(nets)} seen, +{new} new"


# ---------------------------------------------------------------------------
# monitor mode + pcap
# ---------------------------------------------------------------------------

async def enable_monitor() -> str:
    if STATE.monitor_on:
        return "already in monitor mode"
    cmds = [
        ("ip", "link", "set", STATE.iface, "down"),
        ("iw", "dev", STATE.iface, "set", "type", "monitor"),
        ("ip", "link", "set", STATE.iface, "up"),
    ]
    for cmd in cmds:
        rc, _, err = await _run(*cmd, timeout=10)
        if rc != 0:
            # try to roll back to managed
            await _run("iw", "dev", STATE.iface, "set", "type", "managed", timeout=5)
            await _run("ip", "link", "set", STATE.iface, "up", timeout=5)
            raise RuntimeError(f"{' '.join(cmd)} failed: {err.strip()}")
    STATE.monitor_on = True
    STATE.status_msg = "monitor mode ON"
    return "monitor mode enabled"


async def disable_monitor() -> str:
    if not STATE.monitor_on:
        return "not in monitor mode"
    await stop_pcap()
    cmds = [
        ("ip", "link", "set", STATE.iface, "down"),
        ("iw", "dev", STATE.iface, "set", "type", "managed"),
        ("ip", "link", "set", STATE.iface, "up"),
    ]
    for cmd in cmds:
        await _run(*cmd, timeout=10)
    STATE.monitor_on = False
    STATE.status_msg = "managed mode"
    return "monitor mode disabled"


_pcap_proc: Optional[asyncio.subprocess.Process] = None
_pcap_task: Optional[asyncio.Task] = None


def _pick_pcap_tool() -> Optional[list[str]]:
    PCAP_DIR.mkdir(parents=True, exist_ok=True)
    out = PCAP_DIR / "wardrive.pcap"
    if shutil.which("dumpcap"):
        # dumpcap rotates files itself: -b filesize:65536 (KiB) -b files:20
        return [
            "dumpcap", "-i", STATE.iface, "-q",
            "-b", "filesize:65536", "-b", "files:20",
            "-w", str(out),
        ]
    if shutil.which("tcpdump"):
        return [
            "tcpdump", "-i", STATE.iface, "-U", "-n",
            "-W", "20", "-C", "64",
            "-w", str(out),
        ]
    return None


async def start_pcap() -> str:
    global _pcap_proc, _pcap_task
    if not STATE.monitor_on:
        raise RuntimeError("enable monitor mode first")
    if _pcap_proc is not None and _pcap_proc.returncode is None:
        return "pcap already running"
    cmd = _pick_pcap_tool()
    if cmd is None:
        raise RuntimeError("neither dumpcap nor tcpdump installed")
    log.info("starting pcap: %s", " ".join(cmd))
    _pcap_proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
    )
    STATE.pcap_on = True
    _pcap_task = asyncio.create_task(_pcap_sampler())
    return "pcap started"


async def stop_pcap() -> str:
    global _pcap_proc, _pcap_task
    if _pcap_proc and _pcap_proc.returncode is None:
        _pcap_proc.terminate()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(_pcap_proc.wait(), timeout=5)
        if _pcap_proc.returncode is None:
            _pcap_proc.kill()
            await _pcap_proc.wait()
    _pcap_proc = None
    if _pcap_task:
        _pcap_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _pcap_task
        _pcap_task = None
    STATE.pcap_on = False
    return "pcap stopped"


async def _pcap_sampler() -> None:
    """Watch pcap file sizes and approximate per-tick packet counts."""
    PCAP_DIR.mkdir(parents=True, exist_ok=True)
    last_total = _pcap_dir_bytes()
    while True:
        await asyncio.sleep(MONITOR_SAMPLE_INTERVAL)
        if _pcap_proc is None or _pcap_proc.returncode is not None:
            return
        total = _pcap_dir_bytes()
        delta = max(0, total - last_total)
        last_total = total
        # ~250 bytes per management frame is a defensible average.
        approx_pkts = delta // 250
        STATE.add_packets(int(approx_pkts), int(delta))
        STATE.status_msg = f"pcap: +{approx_pkts}p ({delta//1024}KiB/s avg)"


def _pcap_dir_bytes() -> int:
    if not PCAP_DIR.exists():
        return 0
    return sum(p.stat().st_size for p in PCAP_DIR.glob("*") if p.is_file())


# ---------------------------------------------------------------------------
# decay loop (keeps the speedometer responsive)
# ---------------------------------------------------------------------------

async def decay_loop() -> None:
    last = time.time()
    while True:
        await asyncio.sleep(0.5)
        now = time.time()
        STATE.decay_window(now - last)
        last = now
