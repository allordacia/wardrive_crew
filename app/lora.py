"""LoRa fleet beacons via Meshtastic.

Broadcasts a small JSON beacon (crew_id, score, mph, lat, lon) every
N seconds over a custom Meshtastic app port; receives the same from
other crews running wardrive_crew. Other crews show up in
STATE.fleet and the frontend renders them as ghost-car silhouettes
on the road.

Prereqs:
  - SX1262 module flashed with Meshtastic firmware (the AIO v2's LoRa
    is built around this, but the firmware flash is a one-time step
    the user does themselves with the Meshtastic CLI).
  - The Meshtastic node is exposed to Linux as a serial device, e.g.
    /dev/ttyACM0 or /dev/ttyUSB0.

Opt-in via env:
  WARDRIVE_LORA_DEVICE   - serial device path (empty = disabled)
  WARDRIVE_CREW_ID       - short crew name (auto-generated if absent)
  WARDRIVE_LORA_INTERVAL - seconds between beacons (default 30)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Optional

try:
    import meshtastic.serial_interface  # type: ignore
    from pubsub import pub  # type: ignore
    _HAS_MESHTASTIC = True
except Exception:  # noqa: BLE001
    _HAS_MESHTASTIC = False

from .state import STATE


log = logging.getLogger("wardrive.lora")

# Meshtastic "private app" port that other Meshtastic apps will ignore.
# 256 is the start of the user/private port range.
LORA_APP_PORT = 256
FLEET_TIMEOUT = 300.0


def _make_beacon(crew_id: str) -> bytes:
    payload = {
        "v": 1,
        "crew_id": crew_id,
        "score": STATE.total_networks(),
        "mph": round(STATE.speed_mph(), 1),
        "lat": STATE.gps.lat if STATE.gps.have_fix else None,
        "lon": STATE.gps.lon if STATE.gps.have_fix else None,
        "ts": time.time(),
    }
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


async def lora_loop() -> None:
    device = os.environ.get("WARDRIVE_LORA_DEVICE", "").strip()
    if not device:
        return
    if not _HAS_MESHTASTIC:
        log.error("WARDRIVE_LORA_DEVICE=%s but meshtastic library not installed", device)
        return

    crew_id = (os.environ.get("WARDRIVE_CREW_ID", "").strip()
               or f"crew_{uuid.uuid4().hex[:6]}")
    STATE.crew_id = crew_id

    try:
        interval = float(os.environ.get("WARDRIVE_LORA_INTERVAL", "30"))
    except ValueError:
        interval = 30.0

    iface = None
    try:
        log.info("lora: connecting to %s", device)
        iface = await asyncio.to_thread(
            meshtastic.serial_interface.SerialInterface, devPath=device
        )
        STATE.lora_active = True

        def _on_receive(packet, interface):  # noqa: ARG001
            try:
                decoded = packet.get("decoded") if isinstance(packet, dict) else None
                if not decoded:
                    return
                # Meshtastic exposes portnum either as int or named string.
                pn = decoded.get("portnum")
                if pn not in (LORA_APP_PORT, "PRIVATE_APP"):
                    return
                payload = decoded.get("payload")
                if not payload:
                    return
                if isinstance(payload, str):
                    payload = payload.encode()
                data = json.loads(payload.decode("utf-8", errors="ignore"))
                if not isinstance(data, dict):
                    return
                cid = str(data.get("crew_id") or "")
                if not cid or cid == crew_id:
                    return
                STATE.update_fleet_member(cid, data)
                log.debug("lora rx beacon from %s: score=%s", cid, data.get("score"))
            except Exception as e:  # noqa: BLE001
                log.debug("lora rx parse err: %s", e)

        try:
            pub.subscribe(_on_receive, "meshtastic.receive")
        except Exception as e:  # noqa: BLE001
            log.warning("lora: pubsub subscribe failed: %s", e)

        log.info("lora: ready as crew=%s, beacon every %.0fs", crew_id, interval)

        while True:
            await asyncio.sleep(interval)
            try:
                payload = _make_beacon(crew_id)
                await asyncio.to_thread(
                    iface.sendData,
                    payload,
                    portNum=LORA_APP_PORT,
                    wantAck=False,
                )
            except Exception as e:  # noqa: BLE001
                log.warning("lora tx err: %s", e)
            STATE.prune_fleet(FLEET_TIMEOUT)
    except Exception as e:  # noqa: BLE001
        log.error("lora: connection failed: %s", e)
    finally:
        STATE.lora_active = False
        if iface is not None:
            try:
                await asyncio.to_thread(iface.close)
            except Exception:  # noqa: BLE001
                pass
