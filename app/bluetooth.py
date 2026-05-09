"""Optional passive BLE scanner — Bluetooth device tracking.

When WARDRIVE_BT_ENABLED=1 we drive a continuous BLE advertisement scan
through bleak (BlueZ + DBus on the host). Each advertisement we hear
becomes a row in the `bt_devices` table; the operator terminal surfaces
the visible list with the same click-to-flag whitelist / target affordances
the wifi panel uses.

This is BLE-only by design — Classic-BR/EDR Bluetooth would need a
shell-based bluetoothctl loop and messier dedupe. Most modern devices
(phones, wearables, beacons, AirTags, fitness sensors) advertise on BLE,
so this catches the bulk of war-walking signals.

Env:
  WARDRIVE_BT_ENABLED   - 1 to run the loop (default 0)
  WARDRIVE_BT_INTERVAL  - seconds per scan window (default 8)
  WARDRIVE_BT_ADAPTER   - hci adapter name, e.g. hci0 (default: bleak picks one)
"""

from __future__ import annotations

import asyncio
import logging
import os
import time

from .state import STATE


log = logging.getLogger("wardrive.bt")


def _detection_callback(device, adv_data) -> None:
    """Called on every BLE advertisement bleak hears. Pushes into STATE."""
    try:
        # adv_data.local_name is the friendly name from the advertisement;
        # device.name is bleak's resolved name. Either may be None.
        name = (getattr(adv_data, "local_name", None)
                or getattr(device, "name", None)
                or "")
        rssi = getattr(adv_data, "rssi", None)
        if rssi is None:
            rssi = getattr(device, "rssi", None)

        # manufacturer_data is a dict {company_id: bytes}; just record the
        # first company id so the UI can show vendor hints without storing
        # the raw advertising payload.
        mfg = ""
        mdata = getattr(adv_data, "manufacturer_data", None) or {}
        if mdata:
            cid = next(iter(mdata.keys()))
            mfg = f"0x{cid:04x}"

        STATE.add_bt_device(
            mac=device.address,
            name=name or "",
            rssi=int(rssi) if rssi is not None else None,
            manufacturer=mfg,
        )
    except Exception:  # noqa: BLE001
        # never crash the scanner on a single advertisement
        log.exception("bt: detection callback failed")


async def bt_loop() -> None:
    """Long-running BLE scan loop. No-op when WARDRIVE_BT_ENABLED != 1."""
    if os.environ.get("WARDRIVE_BT_ENABLED", "0") != "1":
        log.info("bt: disabled (set WARDRIVE_BT_ENABLED=1 to enable)")
        return

    try:
        from bleak import BleakScanner  # type: ignore
    except ImportError as e:
        log.warning("bt: bleak not installed (%s); BT scanning disabled", e)
        return

    interval = int(os.environ.get("WARDRIVE_BT_INTERVAL", "8"))
    adapter = os.environ.get("WARDRIVE_BT_ADAPTER", "").strip() or None

    STATE.bt_active = True
    STATE.bt_adapter = adapter or "default"
    log.info("bt: enabled, adapter=%s, scan_window=%ds", adapter or "auto", interval)

    while True:
        seen_at_start = STATE.bt_devices_total()
        try:
            scanner = BleakScanner(
                detection_callback=_detection_callback,
                adapter=adapter,
            )
            STATE.bt_last_scan_ts = time.time()
            await scanner.start()
            await asyncio.sleep(interval)
            await scanner.stop()
        except asyncio.CancelledError:
            log.info("bt: scan cancelled")
            STATE.bt_active = False
            raise
        except Exception as e:  # noqa: BLE001
            STATE.bt_active = False
            STATE.status_msg = f"bt: scan failed: {e}"
            log.warning("bt: scan failed: %s; retrying in %ds", e, interval * 2)
            await asyncio.sleep(interval * 2)
            STATE.bt_active = True
            continue

        seen_at_end = STATE.bt_devices_total()
        STATE.bt_last_scan_new = max(0, seen_at_end - seen_at_start)
        STATE.bt_last_scan_seen = STATE.bt_visible_count(max_age_s=interval * 3.0)
        # tiny breath between cycles so the asyncio loop stays responsive
        await asyncio.sleep(0.2)
