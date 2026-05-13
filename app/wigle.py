"""Wigle.net upload integration.

Two responsibilities:

1. Build a WigleWifi-1.6 CSV from the wifi networks observed during a
   mission window. The format is a single header line plus one row per
   network with first-seen timestamp, BSSID, SSID, capabilities,
   channel, RSSI, lat / lon / alt / accuracy, and ``WIFI`` type.

2. POST that CSV to ``https://api.wigle.net/api/v2/file/upload`` using
   HTTP Basic auth (API name + API token from the settings table).

We don't bring in `httpx` / `requests` for this — stdlib `urllib` plus
a tiny multipart encoder is enough and avoids a new wheel on the
uConsole.
"""

from __future__ import annotations

import io
import json
import logging
import time
import urllib.error
import urllib.request
import uuid
from base64 import b64encode
from datetime import datetime, timezone
from typing import Optional

from .state import STATE


log = logging.getLogger("wardrive.wigle")

WIGLE_UPLOAD_URL = "https://api.wigle.net/api/v2/file/upload"
WIGLE_TIMEOUT_S = 60.0

# Settings table keys
SK_API_NAME  = "wigle.api_name"
SK_API_TOKEN = "wigle.api_token"
SK_DONATE    = "wigle.donate"     # "1" or "0"


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------

def get_credentials() -> tuple[str, str]:
    """Return (api_name, api_token), each empty string if unset."""
    name  = (STATE.get_setting(SK_API_NAME)  or "").strip()
    token = (STATE.get_setting(SK_API_TOKEN) or "").strip()
    return name, token


def credentials_present() -> bool:
    name, token = get_credentials()
    return bool(name and token)


def set_credentials(api_name: str, api_token: str) -> None:
    STATE.set_setting(SK_API_NAME,  (api_name or "").strip())
    STATE.set_setting(SK_API_TOKEN, (api_token or "").strip())


def get_donate() -> bool:
    return (STATE.get_setting(SK_DONATE) or "0") == "1"


def set_donate(on: bool) -> None:
    STATE.set_setting(SK_DONATE, "1" if on else "0")


# ---------------------------------------------------------------------------
# CSV builder
# ---------------------------------------------------------------------------

def _fmt_ts(t: float) -> str:
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _wigle_caps(enc: str) -> str:
    """Best-effort mapping from our `encryption` column to the bracketed
    capabilities field Wigle expects (e.g. ``[WPA2-PSK-CCMP][ESS]``)."""
    s = (enc or "").upper().strip()
    if not s or s == "--":
        return "[ESS]"
    parts = []
    if "WPA3" in s: parts.append("WPA3")
    if "WPA2" in s: parts.append("WPA2")
    if "WPA"  in s and "WPA2" not in s and "WPA3" not in s: parts.append("WPA")
    if "WEP"  in s: parts.append("WEP")
    if not parts:
        if "OPEN" in s or "NONE" in s:
            return "[ESS]"
        parts.append(s.split()[0])  # fall back to first token
    return "".join(f"[{p}]" for p in parts) + "[ESS]"


def build_csv(mission_id: int) -> tuple[str, int]:
    """Render a WigleWifi-1.6 CSV for every wifi network whose first
    observation falls inside the named mission's window. Returns
    ``(csv_text, row_count)``.

    Notes:
      - We use ``first_seen`` (not last_seen) to scope rows to the
        mission. A network we already knew about doesn't count as a
        new sighting for this drive.
      - Networks without lat/lon are skipped — Wigle requires
        coordinates.
    """
    cur = STATE.db.execute(
        "SELECT started_at, ended_at FROM missions WHERE id=?",
        (mission_id,),
    )
    row = cur.fetchone()
    if not row:
        raise ValueError(f"mission {mission_id} not found")
    t0, t1 = row[0], (row[1] or time.time())

    cur = STATE.db.execute(
        "SELECT bssid, ssid, channel, signal, encryption, first_seen, lat, lon "
        "FROM networks "
        "WHERE first_seen >= ? AND first_seen <= ? "
        "AND lat IS NOT NULL AND lon IS NOT NULL "
        "ORDER BY first_seen ASC",
        (t0, t1),
    )
    rows = cur.fetchall()

    buf = io.StringIO()
    # Pre-row metadata header (Wigle's expected format).
    buf.write(
        "WigleWifi-1.6,appRelease=wardrive_crew,model=uConsole,"
        "release=2025,device=wardrive,display=terminal,board=cm4,"
        "brand=clockwork\r\n"
    )
    buf.write(
        "MAC,SSID,AuthMode,FirstSeen,Channel,RSSI,"
        "CurrentLatitude,CurrentLongitude,AltitudeMeters,"
        "AccuracyMeters,Type\r\n"
    )

    n = 0
    for bssid, ssid, channel, signal, enc, first_seen, lat, lon in rows:
        # Sanitize: SSID can contain commas / quotes — wrap in quotes
        # and double up internal quotes per RFC 4180.
        ssid_out = (ssid or "")
        if any(c in ssid_out for c in (",", '"', "\r", "\n")):
            ssid_out = '"' + ssid_out.replace('"', '""') + '"'
        buf.write(
            f"{bssid},{ssid_out},{_wigle_caps(enc or '')},"
            f"{_fmt_ts(float(first_seen))},"
            f"{int(channel) if channel is not None else 0},"
            f"{int(signal) if signal is not None else 0},"
            f"{float(lat):.7f},{float(lon):.7f},0,0,WIFI\r\n"
        )
        n += 1
    return buf.getvalue(), n


# ---------------------------------------------------------------------------
# Multipart encoder + uploader (stdlib only)
# ---------------------------------------------------------------------------

def _encode_multipart(
    file_field: str,
    filename: str,
    file_bytes: bytes,
    fields: dict[str, str],
) -> tuple[bytes, str]:
    """Return (body, content_type). One file field + N text fields.
    Boundary picked at random per request."""
    boundary = f"----wardrive{uuid.uuid4().hex}"
    crlf = b"\r\n"
    body = io.BytesIO()
    for name, value in fields.items():
        body.write(f"--{boundary}\r\n".encode())
        body.write(
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        )
        body.write(value.encode("utf-8"))
        body.write(crlf)
    body.write(f"--{boundary}\r\n".encode())
    body.write(
        f'Content-Disposition: form-data; name="{file_field}"; '
        f'filename="{filename}"\r\n'.encode()
    )
    body.write(b"Content-Type: text/csv\r\n\r\n")
    body.write(file_bytes)
    body.write(crlf)
    body.write(f"--{boundary}--\r\n".encode())
    return body.getvalue(), f"multipart/form-data; boundary={boundary}"


def upload(mission_id: int) -> dict:
    """Build the CSV for the named mission and POST it to Wigle.
    On success, persist the timestamp + (truncated) response body on
    the mission row so the operator's debriefing pane can reflect
    "uploaded".

    Returns a dict with ``ok``, ``status``, ``rows``, ``response``,
    ``filename``. Raises ``RuntimeError`` if creds are missing — the
    endpoint catches and surfaces it as 400."""
    name, token = get_credentials()
    if not (name and token):
        raise RuntimeError("wigle credentials not configured")

    csv_text, n_rows = build_csv(mission_id)
    if n_rows == 0:
        raise RuntimeError(
            f"mission {mission_id} has no GPS-tagged wifi observations"
        )

    fname = f"wardrive-mission-{mission_id}-{int(time.time())}.csv"
    body, ctype = _encode_multipart(
        file_field="file",
        filename=fname,
        file_bytes=csv_text.encode("utf-8"),
        fields={"donate": "true" if get_donate() else "false"},
    )
    auth = b64encode(f"{name}:{token}".encode()).decode()
    req = urllib.request.Request(
        WIGLE_UPLOAD_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": ctype,
            "Accept": "application/json",
            "User-Agent": "wardrive_crew/1.0",
        },
    )
    log.info("wigle: uploading mission=%s rows=%d bytes=%d",
             mission_id, n_rows, len(body))
    status = 0
    raw_resp = ""
    ok = False
    try:
        with urllib.request.urlopen(req, timeout=WIGLE_TIMEOUT_S) as resp:
            status = resp.status
            raw_resp = resp.read().decode("utf-8", errors="replace")
            ok = 200 <= status < 300
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            raw_resp = e.read().decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            raw_resp = str(e)
        ok = False
    except Exception as e:  # noqa: BLE001
        status = 0
        raw_resp = f"transport error: {e}"
        ok = False

    # Persist outcome on the missions row regardless of success — the
    # operator may want to see the failure response in the UI.
    truncated = raw_resp[:1000]
    if ok:
        STATE.db.execute(
            "UPDATE missions SET wigle_uploaded_at=?, wigle_response=? WHERE id=?",
            (time.time(), truncated, mission_id),
        )
    else:
        STATE.db.execute(
            "UPDATE missions SET wigle_response=? WHERE id=?",
            (f"FAIL[{status}] {truncated}", mission_id),
        )
    STATE.db.commit()

    parsed: Optional[dict] = None
    try:
        parsed = json.loads(raw_resp)
    except Exception:  # noqa: BLE001
        pass

    return {
        "ok": ok,
        "status": status,
        "rows": n_rows,
        "filename": fname,
        "response": parsed if parsed is not None else truncated,
    }
