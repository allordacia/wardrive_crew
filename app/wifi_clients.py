"""Wifi STA / client tracker.

When monitor mode is on we already write everything to a rotating
pcap. This module spins a *separate* tshark sidecar that filters for
client-side management frames and feeds STATE so the operator
terminal's WIFI.CLIENTS tab shows a live list of nearby phones /
laptops / IoT devices.

Frames captured (all 802.11 management subtypes that originate from a
STA, never from an AP):

  0x04  probe request    — STA looking for an AP. Carries the SSID
                            the client is asking for, which is the
                            classic privacy-leak surface (hotel wifi,
                            home network names, etc).
  0x00  association req  — STA wants to join an AP.
  0x02  reassociation req

The source MAC is the STA. Locally-administered MACs (second-LSB of
first octet = 1) are flagged ``is_random`` so the UI can tell them
from real, persistent identifiers.

Only runs while ``STATE.monitor_on`` is true; respawns automatically
when monitor mode is cycled off and on. No-op until monitor is enabled
(this is purely a sidecar; the existing dumpcap rotation is unaffected).
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil

from .state import STATE


log = logging.getLogger("wardrive.clients")


# Display filter — only management frames that come *from* a STA.
TSHARK_FILTER = (
    "wlan.fc.type_subtype == 0x04 || "  # probe request
    "wlan.fc.type_subtype == 0x00 || "  # association request
    "wlan.fc.type_subtype == 0x02"      # reassociation request
)

# Fields we ask tshark to emit per frame. -E separator=| keeps things
# unambiguous since SSIDs can legitimately contain commas / tabs.
TSHARK_FIELDS = [
    "wlan.sa",                   # source MAC (the STA)
    "wlan.ssid",                 # probed SSID (probe-req); empty for broadcast
    "wlan.fc.type_subtype",      # 0x04 / 0x00 / 0x02
    "radiotap.dbm_antsignal",    # RSSI in dBm if radiotap header present
]


def _is_random_mac(mac: str) -> bool:
    """A locally-administered (randomised) MAC has bit 1 of the first
    octet set. Phones use these for probe requests so the AP they're
    looking at can't passively track them across networks."""
    try:
        first = int(mac.split(":")[0], 16)
    except (ValueError, IndexError):
        return False
    return bool(first & 0x02)


async def _read_pipe(stream: asyncio.StreamReader) -> None:
    """Drain stderr to the log so tshark errors aren't silent."""
    while True:
        line = await stream.readline()
        if not line:
            return
        msg = line.decode(errors="replace").rstrip()
        if msg:
            log.warning("tshark: %s", msg)


async def _run_tshark(iface: str) -> None:
    """One tshark invocation against the monitor iface. Returns when
    the process exits or monitor mode flips off."""
    if not shutil.which("tshark"):
        log.warning("tshark not in PATH; STA tracking disabled")
        await asyncio.sleep(60)
        return

    args = [
        "tshark", "-i", iface, "-l", "-n",
        "-T", "fields", "-E", "separator=|",
    ]
    for f in TSHARK_FIELDS:
        args += ["-e", f]
    args += ["-Y", TSHARK_FILTER]

    log.info("clients: starting tshark on %s", iface)
    STATE.wifi_clients_active = True
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except Exception as e:  # noqa: BLE001
        log.warning("clients: tshark spawn failed: %s", e)
        STATE.wifi_clients_active = False
        await asyncio.sleep(5)
        return

    err_task = asyncio.create_task(_read_pipe(proc.stderr))
    try:
        assert proc.stdout is not None
        while True:
            # Stop tshark if the operator turned monitor off.
            if not STATE.monitor_on:
                log.info("clients: monitor mode off; stopping tshark")
                break
            try:
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=2.0)
            except asyncio.TimeoutError:
                continue
            if not line:
                break  # tshark exited
            _ingest_line(line.decode(errors="replace").strip())
    finally:
        STATE.wifi_clients_active = False
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=2.0)
        except Exception:  # noqa: BLE001
            try:
                proc.kill()
                await proc.wait()
            except Exception:  # noqa: BLE001
                pass
        err_task.cancel()
        try:
            await err_task
        except (asyncio.CancelledError, Exception):
            pass


def _ingest_line(line: str) -> None:
    """Parse one tshark output line and update STATE."""
    if not line:
        return
    fields = line.split("|")
    if len(fields) < 3:
        return
    mac = (fields[0] or "").strip().lower()
    ssid = (fields[1] or "").strip()
    subtype_raw = (fields[2] or "").strip()
    rssi_raw = fields[3] if len(fields) > 3 else ""
    if not mac or len(mac) != 17:
        return

    # Skip APs we already track in `networks` — when a known BSSID
    # accidentally matches, it's an AP, not a STA.
    cur = STATE.db.execute("SELECT 1 FROM networks WHERE bssid=?", (mac,))
    if cur.fetchone() is not None:
        return

    try:
        subtype = int(subtype_raw, 0) if subtype_raw else None
    except ValueError:
        subtype = None
    rssi = None
    if rssi_raw:
        try:
            rssi = int(rssi_raw.split(",")[0])
        except ValueError:
            rssi = None

    STATE.add_wifi_client(
        mac=mac,
        ssid_probed=ssid,
        subtype=subtype,
        signal=rssi,
        is_random=_is_random_mac(mac),
    )


async def wifi_clients_loop() -> None:
    """Long-running supervisor: when monitor mode is on, run tshark
    against the monitor iface; when monitor flips off, stay idle."""
    if os.environ.get("WARDRIVE_CLIENTS_ENABLED", "1") != "1":
        log.info("clients: disabled via WARDRIVE_CLIENTS_ENABLED")
        return
    while True:
        if not STATE.monitor_on:
            await asyncio.sleep(2.0)
            continue
        iface = (STATE.monitor_iface or STATE.iface or "").strip()
        if not iface:
            await asyncio.sleep(2.0)
            continue
        await _run_tshark(iface)
        # Brief breather before the next attempt.
        await asyncio.sleep(1.0)
