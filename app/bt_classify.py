"""BLE tracker classifier — identify Find-My / iBeacon / Eddystone /
common consumer trackers from advertisement payloads.

Returns a short tag string (e.g. "airtag", "tile", "smarttag", "ibeacon",
"eddystone", "samsung", "apple", "tile-pro") that the operator terminal
displays as a `[ TAG ]` chip on the BT.DEVICES row.

The classification is best-effort and based on public manufacturer data
formats:
  - Apple Find-My / AirTag / AirPods: company ID 0x004C, Apple-specific
    sub-type byte. AirTags advertise with type 0x12 ("Offline Finding")
    and a 25-byte payload.
  - Tile: company ID 0x0067 (older) and 0x002C (newer Tile Pro firmware).
  - Samsung SmartTag: company ID 0x0075 with a SmartThings header.
  - Eddystone: service UUID 0xFEAA in service_uuids.
  - iBeacon: company ID 0x004C with sub-type 0x02, length 0x15.

This file has no I/O — it's pure parsing. The `bt_loop` callback feeds
adv_data dicts in and stores the resulting tag on the device row.
"""

from __future__ import annotations


# Company IDs that map straight to a vendor hint (no further parsing).
# Source: Bluetooth SIG "Assigned Numbers — Company Identifiers".
COMPANY_HINTS = {
    0x004C: "apple",
    0x0067: "tile",
    0x002C: "tile",
    0x0075: "samsung",
    0x0006: "microsoft",
    0x0087: "garmin",
    0x000F: "broadcom",
    0x00E0: "google",
    0x0157: "anhui",       # Mi Band common
}

EDDYSTONE_SERVICE_UUID = "0000feaa-0000-1000-8000-00805f9b34fb"


def classify(adv_data) -> str:
    """Return a short tracker / beacon tag, or empty string if no match.

    `adv_data` is a bleak AdvertisementData (or any object with the same
    attributes: ``manufacturer_data`` dict, ``service_uuids`` list,
    ``service_data`` dict, ``local_name`` str).
    """
    mdata = getattr(adv_data, "manufacturer_data", None) or {}
    service_uuids = [u.lower() for u in (getattr(adv_data, "service_uuids", None) or [])]
    name = (getattr(adv_data, "local_name", None) or "").strip()

    # Eddystone — Google's open beacon spec.
    if EDDYSTONE_SERVICE_UUID in service_uuids:
        return "eddystone"

    # Apple offline finding / AirTag / iBeacon all live under 0x004C.
    if 0x004C in mdata:
        payload = bytes(mdata[0x004C])
        if len(payload) >= 2:
            sub = payload[0]
            length = payload[1]
            if sub == 0x12 and length >= 0x19:
                return "airtag"          # Find-My non-owner advertisement
            if sub == 0x07:
                return "airpods"
            if sub == 0x02 and length == 0x15 and len(payload) >= 23:
                return "ibeacon"
            if sub == 0x10:
                return "apple-nearby"     # handoff / nearby info
        return "apple"

    # Tile — both legacy and Tile Pro firmware.
    if 0x0067 in mdata or 0x002C in mdata:
        return "tile"

    # Samsung SmartTag advertises with manufacturer 0x0075.
    if 0x0075 in mdata:
        # SmartTag adverts begin with 0x42 in payload byte 0; but vendor=samsung
        # is enough for the tag chip on the UI.
        return "smarttag"

    # Chipolo, generic-named trackers — name match fallback.
    n = name.lower()
    if n.startswith("chipolo"):
        return "chipolo"
    if "airtag" in n:
        return "airtag"
    if n.startswith("tile") or n == "tile":
        return "tile"

    # Generic vendor hint if nothing more specific matched.
    if mdata:
        cid = next(iter(mdata.keys()))
        return COMPANY_HINTS.get(cid, "")
    return ""


# Tags that are *trackers* specifically (vs general-purpose beacons / vendor
# hints). Used by the UI to decide whether to flash a tracker badge and by
# the auto-flag logic below.
TRACKER_TAGS = {"airtag", "tile", "smarttag", "chipolo"}
