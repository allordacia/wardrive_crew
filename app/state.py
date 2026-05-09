import asyncio
import math
import os
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


DATA_DIR = Path(os.environ.get("WARDRIVE_DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "wardrive.sqlite"


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS networks (
            bssid TEXT PRIMARY KEY,
            ssid TEXT,
            channel INTEGER,
            signal INTEGER,
            encryption TEXT,
            first_seen REAL,
            last_seen REAL,
            lat REAL,
            lon REAL,
            whitelisted INTEGER NOT NULL DEFAULT 0,
            targeted INTEGER NOT NULL DEFAULT 0,
            band TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS bt_devices (
            mac TEXT PRIMARY KEY,
            name TEXT,
            rssi INTEGER,
            manufacturer TEXT,
            first_seen REAL,
            last_seen REAL,
            lat REAL,
            lon REAL,
            whitelisted INTEGER NOT NULL DEFAULT 0,
            targeted INTEGER NOT NULL DEFAULT 0,
            tracker_type TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS counters (
            name TEXT PRIMARY KEY,
            value INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        -- Wardriving session lifecycle. The operator starts a mission
        -- (or it auto-starts on first observation), accumulates
        -- networks / BT / RF / clients in the regular tables, then
        -- ends it — at which point a debriefing summary is computed
        -- (counts, points, distance traveled, duration). Wigle uploads
        -- and DB backups are scoped to the most recently ended mission.
        CREATE TABLE IF NOT EXISTS missions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at REAL NOT NULL,
            ended_at REAL,
            label TEXT NOT NULL DEFAULT '',
            summary TEXT NOT NULL DEFAULT '',
            wigle_uploaded_at REAL,
            wigle_response TEXT NOT NULL DEFAULT ''
        );
        -- STA / client side of wifi monitor mode. Each row is one
        -- 802.11 management-frame source MAC (probe-req / assoc-req /
        -- reassoc-req). probed_ssids is a comma-separated list of
        -- distinct SSIDs the client has asked for, capped to keep the
        -- column small.
        CREATE TABLE IF NOT EXISTS wifi_clients (
            mac TEXT PRIMARY KEY,
            is_random INTEGER NOT NULL DEFAULT 0,
            last_signal INTEGER,
            first_seen REAL NOT NULL,
            last_seen REAL NOT NULL,
            probe_count INTEGER NOT NULL DEFAULT 0,
            probed_ssids TEXT NOT NULL DEFAULT '',
            last_subtype INTEGER,
            lat REAL,
            lon REAL,
            whitelisted INTEGER NOT NULL DEFAULT 0,
            targeted INTEGER NOT NULL DEFAULT 0
        );
        -- Consumer-device decodes from rtl_433. Each row is one logical
        -- device (rtl_433 model+id pair); count tracks how many packets
        -- we've seen, last_payload is the most recent JSON line.
        CREATE TABLE IF NOT EXISTS rf_devices (
            device_key TEXT PRIMARY KEY,
            model TEXT NOT NULL,
            dev_id TEXT NOT NULL DEFAULT '',
            channel TEXT NOT NULL DEFAULT '',
            freq_mhz REAL NOT NULL DEFAULT 0,
            rssi INTEGER,
            first_seen REAL NOT NULL,
            last_seen REAL NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            summary TEXT NOT NULL DEFAULT '',
            last_payload TEXT NOT NULL DEFAULT '',
            lat REAL,
            lon REAL,
            whitelisted INTEGER NOT NULL DEFAULT 0,
            targeted INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO counters(name, value) VALUES ('packets', 0);
        INSERT OR IGNORE INTO counters(name, value) VALUES ('pcap_bytes', 0);
        """
    )
    # Migration for dbs created before these columns existed.
    cols = {row[1] for row in conn.execute("PRAGMA table_info(networks)").fetchall()}
    if "whitelisted" not in cols:
        conn.execute("ALTER TABLE networks ADD COLUMN whitelisted INTEGER NOT NULL DEFAULT 0")
    if "targeted" not in cols:
        conn.execute("ALTER TABLE networks ADD COLUMN targeted INTEGER NOT NULL DEFAULT 0")
    if "band" not in cols:
        conn.execute("ALTER TABLE networks ADD COLUMN band TEXT NOT NULL DEFAULT ''")
    bt_cols = {row[1] for row in conn.execute("PRAGMA table_info(bt_devices)").fetchall()}
    if "tracker_type" not in bt_cols:
        conn.execute("ALTER TABLE bt_devices ADD COLUMN tracker_type TEXT NOT NULL DEFAULT ''")
    conn.commit()
    return conn


@dataclass
class GpsFix:
    lat: float = 0.0
    lon: float = 0.0
    speed_mps: float = 0.0
    accuracy_m: float = 0.0
    ts: float = 0.0
    have_fix: bool = False
    source: str = "none"     # "serial" | "browser" | "none"
    sat_count: int = 0       # sats *used in fix* (from $GxGGA field 7)
    hdop: float = 0.0

    # Diagnostics for the "no fix yet" case so the operator terminal can
    # tell the difference between "no NMEA flowing at all" and "NMEA OK
    # but the antenna can't see enough satellites yet".
    nmea_frames: int = 0       # total parseable NMEA sentences seen
    nmea_last_ts: float = 0.0  # wallclock time of the most recent sentence
    sats_tracked: int = 0      # sats *visible* (from $GxGSV totals); ≥ sat_count


@dataclass
class State:
    iface: str = "wlan0"
    # Once monitor mode is on, this may differ from `iface` (airmon-ng creates
    # e.g. wlan0mon). pcap captures from monitor_iface.
    monitor_iface: str = ""
    monitor_on: bool = False
    pcap_on: bool = False
    last_scan_ts: float = 0.0
    new_bssids_window: float = 0.0    # decays over time
    packets_window: float = 0.0
    rf_signals_window: float = 0.0    # decays; SDR sweep peaks
    rf_signals_total: int = 0
    gps: GpsFix = field(default_factory=GpsFix)
    db: sqlite3.Connection = field(default_factory=_connect)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    status_msg: str = "idle"
    # Per-radio operational detail (surfaced to the radio status panel)
    last_scan_seen: int = 0
    last_scan_new: int = 0
    pcap_bytes_rate_s: float = 0.0
    # Optional AIO v2 peripherals
    rtc_synced: bool = False
    rtc_synced_ts: float = 0.0
    rtc_device: str = ""
    sdr_active: bool = False
    sdr_last_band: str = ""
    sdr_last_peaks: int = 0
    sdr_last_ts: float = 0.0
    sdr_bands_count: int = 0
    lora_active: bool = False
    lora_device: str = ""
    lora_tx_count: int = 0
    lora_rx_count: int = 0
    lora_last_tx_ts: float = 0.0
    lora_last_rx_ts: float = 0.0
    crew_id: str = ""
    fleet: dict = field(default_factory=dict)   # crew_id -> last-beacon dict
    # Bluetooth (BLE) scanner — populated only when WARDRIVE_BT_ENABLED=1
    bt_active: bool = False
    bt_adapter: str = ""
    bt_last_scan_ts: float = 0.0
    bt_last_scan_new: int = 0
    bt_last_scan_seen: int = 0
    # rtl_433 consumer-device decoder (mutually exclusive with rtl_power).
    rtl433_active: bool = False
    rtl433_cmd: str = ""
    rtl433_last_ts: float = 0.0
    # tshark sidecar that captures STAs from the monitor iface. Only set
    # while monitor mode is on AND tshark is actively reading frames.
    wifi_clients_active: bool = False
    # Mission lifecycle. status is one of:
    #   "idle"        — no mission in progress
    #   "active"      — mission running, observations are accumulating
    #   "debriefing"  — mission ended, summary visible, awaiting dismiss
    mission_status: str = "idle"
    current_mission_id: int = 0
    current_mission_started_at: float = 0.0

    def total_networks(self) -> int:
        cur = self.db.execute(
            "SELECT COUNT(*) FROM networks WHERE whitelisted=0"
        )
        return int(cur.fetchone()[0])

    def is_whitelisted(self, bssid: str) -> bool:
        cur = self.db.execute(
            "SELECT whitelisted FROM networks WHERE bssid=?", (bssid,)
        )
        row = cur.fetchone()
        return bool(row[0]) if row else False

    def set_whitelist(self, bssid: str, on: bool) -> bool:
        cur = self.db.execute(
            "UPDATE networks SET whitelisted=? WHERE bssid=?",
            (1 if on else 0, bssid),
        )
        self.db.commit()
        return cur.rowcount > 0

    def whitelist_by_ssid(self, ssid: str, on: bool) -> int:
        cur = self.db.execute(
            "UPDATE networks SET whitelisted=? WHERE ssid=?",
            (1 if on else 0, ssid),
        )
        self.db.commit()
        return cur.rowcount

    def set_target(self, bssid: str, on: bool) -> bool:
        """Mark a BSSID as a 'target' (operator focus). Independent of the
        whitelist; surfaced in the operator terminal so the user can build a
        focused list (e.g. for monitor-mode capture or follow-up)."""
        cur = self.db.execute(
            "UPDATE networks SET targeted=? WHERE bssid=?",
            (1 if on else 0, bssid),
        )
        self.db.commit()
        return cur.rowcount > 0

    def visible_networks(self, limit: int = 24, max_age_s: float = 600.0) -> list[dict]:
        """Recently-seen BSSIDs for the live panel on the terminal. Sorted
        by signal strength (strongest first), tie-broken by last_seen."""
        cutoff = time.time() - max_age_s
        cur = self.db.execute(
            "SELECT bssid, ssid, channel, signal, encryption, last_seen, "
            "whitelisted, targeted "
            "FROM networks WHERE last_seen >= ? "
            "ORDER BY COALESCE(signal, -999) DESC, last_seen DESC LIMIT ?",
            (cutoff, max(1, min(limit, 200))),
        )
        out = []
        for r in cur.fetchall():
            out.append({
                "bssid": r[0], "ssid": r[1], "channel": r[2], "signal": r[3],
                "encryption": r[4], "last_seen": r[5],
                "whitelisted": bool(r[6]), "targeted": bool(r[7]),
            })
        return out

    def total_targets(self) -> int:
        cur = self.db.execute("SELECT COUNT(*) FROM networks WHERE targeted=1")
        return int(cur.fetchone()[0])

    # ---- bluetooth (BLE) helpers ----
    def add_bt_device(
        self,
        mac: str,
        name: str,
        rssi: Optional[int],
        manufacturer: str,
        tracker_type: str = "",
    ) -> bool:
        """Insert/update a BLE device. Returns True if it was new.

        ``tracker_type`` is the bt_classify tag string ("airtag", "tile",
        "ibeacon", "eddystone", "smarttag", ...) or "" for unrecognised
        adverts. Only overwrites the stored value when we actually
        recognised something this advertisement, so an anonymous follow-up
        advert from a known AirTag doesn't blank the tag.
        """
        mac = (mac or "").lower()
        if not mac:
            return False
        now = time.time()
        lat = self.gps.lat if self.gps.have_fix else None
        lon = self.gps.lon if self.gps.have_fix else None
        cur = self.db.execute("SELECT 1 FROM bt_devices WHERE mac=?", (mac,))
        new = cur.fetchone() is None
        if new:
            self.db.execute(
                "INSERT INTO bt_devices(mac, name, rssi, manufacturer, "
                "first_seen, last_seen, lat, lon, tracker_type) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (mac, name, rssi, manufacturer, now, now, lat, lon, tracker_type or ""),
            )
        else:
            # Only overwrite name/manufacturer when we actually heard something
            # informative — many BLE adverts come anonymous. Same trick for
            # tracker_type so we keep the most informative classification.
            self.db.execute(
                "UPDATE bt_devices SET "
                "name=COALESCE(NULLIF(?, ''), name), "
                "rssi=COALESCE(?, rssi), "
                "manufacturer=COALESCE(NULLIF(?, ''), manufacturer), "
                "tracker_type=CASE WHEN ?='' THEN tracker_type ELSE ? END, "
                "last_seen=?, "
                "lat=COALESCE(?, lat), lon=COALESCE(?, lon) "
                "WHERE mac=?",
                (name, rssi, manufacturer,
                 tracker_type or "", tracker_type or "",
                 now, lat, lon, mac),
            )
        self.db.commit()
        return new

    def set_bt_whitelist(self, mac: str, on: bool) -> bool:
        cur = self.db.execute(
            "UPDATE bt_devices SET whitelisted=? WHERE mac=?",
            (1 if on else 0, (mac or "").lower()),
        )
        self.db.commit()
        return cur.rowcount > 0

    def set_bt_target(self, mac: str, on: bool) -> bool:
        cur = self.db.execute(
            "UPDATE bt_devices SET targeted=? WHERE mac=?",
            (1 if on else 0, (mac or "").lower()),
        )
        self.db.commit()
        return cur.rowcount > 0

    def visible_bt_devices(self, limit: int = 24, max_age_s: float = 300.0) -> list[dict]:
        """Recently-heard BLE devices for the live BT panel. Sorted by RSSI
        (strongest first), tie-broken by last_seen."""
        cutoff = time.time() - max_age_s
        cur = self.db.execute(
            "SELECT mac, name, rssi, manufacturer, last_seen, "
            "whitelisted, targeted, tracker_type "
            "FROM bt_devices WHERE last_seen >= ? "
            "ORDER BY COALESCE(rssi, -999) DESC, last_seen DESC LIMIT ?",
            (cutoff, max(1, min(limit, 200))),
        )
        out = []
        for r in cur.fetchall():
            out.append({
                "mac": r[0], "name": r[1] or "", "rssi": r[2],
                "manufacturer": r[3] or "", "last_seen": r[4],
                "whitelisted": bool(r[5]), "targeted": bool(r[6]),
                "tracker_type": r[7] or "",
            })
        return out

    def bt_devices_total(self) -> int:
        cur = self.db.execute("SELECT COUNT(*) FROM bt_devices WHERE whitelisted=0")
        return int(cur.fetchone()[0])

    def bt_targets_total(self) -> int:
        cur = self.db.execute("SELECT COUNT(*) FROM bt_devices WHERE targeted=1")
        return int(cur.fetchone()[0])

    def bt_trackers_seen(self) -> dict:
        """Counts of recognised tracker categories ever heard. Drives the
        `// TRACKERS` line on the operator scope so the user can see at a
        glance whether AirTags / Tiles are nearby."""
        cur = self.db.execute(
            "SELECT tracker_type, COUNT(*) FROM bt_devices "
            "WHERE tracker_type != '' GROUP BY tracker_type"
        )
        return {row[0]: int(row[1]) for row in cur.fetchall()}

    # ---- rtl_433 consumer-device helpers ----
    def add_rf_device(
        self,
        key: str,
        model: str,
        dev_id: str,
        channel: str,
        freq_mhz: float,
        rssi: Optional[int],
        summary: str,
        raw: str,
    ) -> bool:
        """Insert/update a decoded rtl_433 device. Returns True if it was
        new. Increments ``count`` on every call so the operator can see
        which devices chatter the most."""
        if not key:
            return False
        now = time.time()
        lat = self.gps.lat if self.gps.have_fix else None
        lon = self.gps.lon if self.gps.have_fix else None
        cur = self.db.execute("SELECT 1 FROM rf_devices WHERE device_key=?", (key,))
        new = cur.fetchone() is None
        if new:
            self.db.execute(
                "INSERT INTO rf_devices(device_key, model, dev_id, channel, "
                "freq_mhz, rssi, first_seen, last_seen, count, summary, "
                "last_payload, lat, lon) "
                "VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)",
                (key, model, dev_id, channel, freq_mhz, rssi,
                 now, now, summary or "", raw or "", lat, lon),
            )
        else:
            self.db.execute(
                "UPDATE rf_devices SET "
                "rssi=COALESCE(?, rssi), last_seen=?, count=count+1, "
                "summary=COALESCE(NULLIF(?, ''), summary), "
                "last_payload=?, "
                "lat=COALESCE(?, lat), lon=COALESCE(?, lon) "
                "WHERE device_key=?",
                (rssi, now, summary or "", raw or "", lat, lon, key),
            )
        self.db.commit()
        return new

    def visible_rf_devices(self, limit: int = 24, max_age_s: float = 600.0) -> list[dict]:
        cutoff = time.time() - max_age_s
        cur = self.db.execute(
            "SELECT device_key, model, dev_id, channel, freq_mhz, rssi, "
            "last_seen, count, summary, whitelisted, targeted "
            "FROM rf_devices WHERE last_seen >= ? "
            "ORDER BY last_seen DESC LIMIT ?",
            (cutoff, max(1, min(limit, 200))),
        )
        return [
            {
                "key": r[0], "model": r[1], "dev_id": r[2], "channel": r[3],
                "freq_mhz": r[4], "rssi": r[5], "last_seen": r[6],
                "count": r[7], "summary": r[8] or "",
                "whitelisted": bool(r[9]), "targeted": bool(r[10]),
            }
            for r in cur.fetchall()
        ]

    def rf_devices_total(self) -> int:
        cur = self.db.execute(
            "SELECT COUNT(*) FROM rf_devices WHERE whitelisted=0"
        )
        return int(cur.fetchone()[0])

    def rf_targets_total(self) -> int:
        cur = self.db.execute("SELECT COUNT(*) FROM rf_devices WHERE targeted=1")
        return int(cur.fetchone()[0])

    def set_rf_whitelist(self, key: str, on: bool) -> bool:
        cur = self.db.execute(
            "UPDATE rf_devices SET whitelisted=? WHERE device_key=?",
            (1 if on else 0, key or ""),
        )
        self.db.commit()
        return cur.rowcount > 0

    def set_rf_target(self, key: str, on: bool) -> bool:
        cur = self.db.execute(
            "UPDATE rf_devices SET targeted=? WHERE device_key=?",
            (1 if on else 0, key or ""),
        )
        self.db.commit()
        return cur.rowcount > 0

    def rf_detail(self, key: str) -> dict | None:
        cur = self.db.execute(
            "SELECT device_key, model, dev_id, channel, freq_mhz, rssi, "
            "first_seen, last_seen, count, summary, last_payload, "
            "whitelisted, targeted FROM rf_devices WHERE device_key=?",
            (key or "",),
        )
        r = cur.fetchone()
        if not r:
            return None
        return {
            "key": r[0], "model": r[1], "dev_id": r[2], "channel": r[3],
            "freq_mhz": r[4], "rssi": r[5],
            "first_seen": r[6], "last_seen": r[7], "count": r[8],
            "summary": r[9] or "", "last_payload": r[10] or "",
            "whitelisted": bool(r[11]), "targeted": bool(r[12]),
        }

    # ---- wifi STA (client) helpers ----
    # Per-STA probed_ssids string is capped at this many entries so a
    # phone wandering past 30 hotel networks doesn't bloat the row.
    PROBED_SSIDS_KEEP = 16

    def add_wifi_client(
        self,
        mac: str,
        ssid_probed: str,
        subtype: Optional[int],
        signal: Optional[int],
        is_random: bool,
    ) -> bool:
        """Record one observed STA frame. Merges the SSID into the
        client's probed_ssids list (deduped, capped). Returns True if
        the STA was new this call."""
        mac = (mac or "").lower()
        if not mac:
            return False
        now = time.time()
        lat = self.gps.lat if self.gps.have_fix else None
        lon = self.gps.lon if self.gps.have_fix else None
        cur = self.db.execute("SELECT probed_ssids FROM wifi_clients WHERE mac=?", (mac,))
        row = cur.fetchone()
        new = row is None
        if new:
            ssids = ssid_probed if ssid_probed else ""
            self.db.execute(
                "INSERT INTO wifi_clients(mac, is_random, last_signal, "
                "first_seen, last_seen, probe_count, probed_ssids, "
                "last_subtype, lat, lon) VALUES (?,?,?,?,?,1,?,?,?,?)",
                (mac, 1 if is_random else 0, signal, now, now,
                 ssids, subtype, lat, lon),
            )
        else:
            existing = (row[0] or "")
            if ssid_probed:
                parts = [s for s in existing.split(",") if s]
                if ssid_probed not in parts:
                    parts.append(ssid_probed)
                    parts = parts[-self.PROBED_SSIDS_KEEP:]
                merged = ",".join(parts)
            else:
                merged = existing
            self.db.execute(
                "UPDATE wifi_clients SET "
                "last_signal=COALESCE(?, last_signal), last_seen=?, "
                "probe_count=probe_count+1, probed_ssids=?, "
                "last_subtype=COALESCE(?, last_subtype), "
                "lat=COALESCE(?, lat), lon=COALESCE(?, lon) "
                "WHERE mac=?",
                (signal, now, merged, subtype, lat, lon, mac),
            )
        self.db.commit()
        return new

    def visible_wifi_clients(self, limit: int = 24, max_age_s: float = 600.0) -> list[dict]:
        cutoff = time.time() - max_age_s
        cur = self.db.execute(
            "SELECT mac, is_random, last_signal, last_seen, probe_count, "
            "probed_ssids, last_subtype, whitelisted, targeted "
            "FROM wifi_clients WHERE last_seen >= ? "
            "ORDER BY last_seen DESC LIMIT ?",
            (cutoff, max(1, min(limit, 200))),
        )
        out = []
        for r in cur.fetchall():
            out.append({
                "mac": r[0], "is_random": bool(r[1]),
                "last_signal": r[2], "last_seen": r[3],
                "probe_count": r[4],
                "probed_ssids": [s for s in (r[5] or "").split(",") if s],
                "last_subtype": r[6],
                "whitelisted": bool(r[7]), "targeted": bool(r[8]),
            })
        return out

    def wifi_clients_total(self) -> int:
        cur = self.db.execute(
            "SELECT COUNT(*) FROM wifi_clients WHERE whitelisted=0"
        )
        return int(cur.fetchone()[0])

    def wifi_client_targets_total(self) -> int:
        cur = self.db.execute(
            "SELECT COUNT(*) FROM wifi_clients WHERE targeted=1"
        )
        return int(cur.fetchone()[0])

    def set_wifi_client_whitelist(self, mac: str, on: bool) -> bool:
        cur = self.db.execute(
            "UPDATE wifi_clients SET whitelisted=? WHERE mac=?",
            (1 if on else 0, (mac or "").lower()),
        )
        self.db.commit()
        return cur.rowcount > 0

    def set_wifi_client_target(self, mac: str, on: bool) -> bool:
        cur = self.db.execute(
            "UPDATE wifi_clients SET targeted=? WHERE mac=?",
            (1 if on else 0, (mac or "").lower()),
        )
        self.db.commit()
        return cur.rowcount > 0

    # ---- mission lifecycle ----
    def start_mission(self, label: str = "") -> dict:
        """Start a new mission unless one is already active."""
        if self.mission_status == "active" and self.current_mission_id:
            return self.mission_current()
        # If we were in debriefing, leave the prior mission row intact
        # (its ended_at + summary are already populated) and just start
        # a fresh one.
        now = time.time()
        cur = self.db.execute(
            "INSERT INTO missions(started_at, label) VALUES (?, ?)",
            (now, (label or "")[:64]),
        )
        self.db.commit()
        self.current_mission_id = int(cur.lastrowid or 0)
        self.current_mission_started_at = now
        self.mission_status = "active"
        return self.mission_current()

    def end_mission(self) -> dict:
        """End the current mission and flip into debriefing. Computes
        the summary (counts / duration / distance / points) and stores
        it as JSON on the mission row."""
        if self.mission_status != "active" or not self.current_mission_id:
            return self.mission_current()
        now = time.time()
        mid = self.current_mission_id
        started_at = self.current_mission_started_at or now
        summary = self._compute_mission_summary(started_at, now)
        try:
            import json as _json
            payload = _json.dumps(summary)
        except Exception:  # noqa: BLE001
            payload = "{}"
        self.db.execute(
            "UPDATE missions SET ended_at=?, summary=? WHERE id=?",
            (now, payload, mid),
        )
        self.db.commit()
        self.mission_status = "debriefing"
        return self.mission_current()

    def dismiss_debriefing(self) -> dict:
        """Acknowledge the debriefing screen. Returns to idle without
        starting a new mission."""
        if self.mission_status == "debriefing":
            self.mission_status = "idle"
        return self.mission_current()

    def mission_current(self) -> dict:
        """Return current mission state plus the most recently ended
        mission's summary (so the debriefing screen has data to show
        even if the active mission already advanced)."""
        out = {
            "status": self.mission_status,
            "id": self.current_mission_id or None,
            "started_at": self.current_mission_started_at or None,
            "summary": None,
            "label": "",
        }
        if self.current_mission_id:
            cur = self.db.execute(
                "SELECT id, started_at, ended_at, label, summary, "
                "wigle_uploaded_at FROM missions WHERE id=?",
                (self.current_mission_id,),
            )
            r = cur.fetchone()
            if r:
                import json as _json
                try:
                    summary = _json.loads(r[4]) if r[4] else None
                except Exception:  # noqa: BLE001
                    summary = None
                out.update({
                    "id": r[0],
                    "started_at": r[1],
                    "ended_at": r[2],
                    "label": r[3] or "",
                    "summary": summary,
                    "wigle_uploaded_at": r[5],
                })
        return out

    def _compute_mission_summary(self, t0: float, t1: float) -> dict:
        """Tally everything observed within [t0, t1]."""
        def _count(table: str, col: str = "first_seen") -> int:
            cur = self.db.execute(
                f"SELECT COUNT(*) FROM {table} WHERE {col} >= ? AND {col} <= ?",
                (t0, t1),
            )
            return int(cur.fetchone()[0])

        def _haversine(lat1, lon1, lat2, lon2) -> float:
            import math as _m
            R = 6371000.0
            phi1, phi2 = _m.radians(lat1), _m.radians(lat2)
            dphi = _m.radians(lat2 - lat1)
            dlmb = _m.radians(lon2 - lon1)
            a = (_m.sin(dphi/2) ** 2
                 + _m.cos(phi1) * _m.cos(phi2) * _m.sin(dlmb/2) ** 2)
            return 2 * R * _m.asin(min(1.0, _m.sqrt(a)))

        # Distance: stitch together the GPS coordinates we attached to
        # each observation in this window. network_observations is the
        # densest source of breadcrumbs while monitor / scan is running.
        cur = self.db.execute(
            "SELECT lat, lon FROM network_observations "
            "WHERE ts >= ? AND ts <= ? AND lat IS NOT NULL AND lon IS NOT NULL "
            "ORDER BY ts ASC",
            (t0, t1),
        )
        prev = None
        meters = 0.0
        for lat, lon in cur.fetchall():
            if prev is not None:
                meters += _haversine(prev[0], prev[1], lat, lon)
            prev = (lat, lon)

        new_nets    = _count("networks")
        new_bt      = _count("bt_devices")
        new_rf      = _count("rf_devices")
        new_clients = _count("wifi_clients")

        # Simple weighted points formula. New BSSIDs count most, since
        # finding new wifi was the original wardriving objective.
        points = (new_nets * 10
                  + new_clients * 4
                  + new_bt * 5
                  + new_rf * 3)

        return {
            "started_at": t0,
            "ended_at": t1,
            "duration_s": round(max(0.0, t1 - t0), 1),
            "distance_m": round(meters, 1),
            "new_networks": new_nets,
            "new_bt_devices": new_bt,
            "new_rf_devices": new_rf,
            "new_clients": new_clients,
            "points": int(points),
        }

    def list_missions(self, limit: int = 20) -> list[dict]:
        cur = self.db.execute(
            "SELECT id, started_at, ended_at, label, summary, "
            "wigle_uploaded_at FROM missions "
            "ORDER BY started_at DESC LIMIT ?",
            (max(1, min(limit, 200)),),
        )
        import json as _json
        out = []
        for r in cur.fetchall():
            try:
                summary = _json.loads(r[4]) if r[4] else None
            except Exception:  # noqa: BLE001
                summary = None
            out.append({
                "id": r[0],
                "started_at": r[1],
                "ended_at": r[2],
                "label": r[3] or "",
                "summary": summary,
                "wigle_uploaded_at": r[5],
            })
        return out

    def bt_visible_count(self, max_age_s: float = 30.0) -> int:
        cutoff = time.time() - max_age_s
        cur = self.db.execute(
            "SELECT COUNT(*) FROM bt_devices WHERE last_seen >= ?", (cutoff,)
        )
        return int(cur.fetchone()[0])

    # ---- generic key/value settings ----
    def get_setting(self, key: str, default: str | None = None) -> str | None:
        cur = self.db.execute("SELECT value FROM settings WHERE key=?", (key,))
        row = cur.fetchone()
        return row[0] if row else default

    def set_setting(self, key: str, value: str) -> None:
        self.db.execute(
            "INSERT INTO settings(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        self.db.commit()

    def total_packets(self) -> int:
        cur = self.db.execute("SELECT value FROM counters WHERE name='packets'")
        row = cur.fetchone()
        return int(row[0]) if row else 0

    def total_pcap_bytes(self) -> int:
        cur = self.db.execute("SELECT value FROM counters WHERE name='pcap_bytes'")
        row = cur.fetchone()
        return int(row[0]) if row else 0

    def add_network(
        self,
        bssid: str,
        ssid: str,
        channel: Optional[int],
        signal: Optional[int],
        encryption: Optional[str],
        band: str = "",
    ) -> bool:
        """Insert/update network. Returns True if it was new.

        ``band`` is "2g" / "5g" / "6g" / "" — derived by the scanner from
        the advertisement frequency. Recorded so we can give per-band
        BSSID counts on the operator scope without re-deriving from the
        channel number (channel 1 in 2.4 GHz != channel 1 in 6 GHz).
        """
        now = time.time()
        lat = self.gps.lat if self.gps.have_fix else None
        lon = self.gps.lon if self.gps.have_fix else None
        cur = self.db.execute(
            "SELECT bssid, whitelisted FROM networks WHERE bssid=?", (bssid,)
        )
        row = cur.fetchone()
        new = row is None
        # An SSID-level whitelist applies to newly-discovered BSSIDs that
        # match a known whitelisted SSID. That way "whitelist Verizon-Home"
        # also covers the next BSSID the same SSID broadcasts on.
        whitelisted = 0
        if new and ssid:
            cur2 = self.db.execute(
                "SELECT 1 FROM networks WHERE ssid=? AND whitelisted=1 LIMIT 1",
                (ssid,),
            )
            if cur2.fetchone() is not None:
                whitelisted = 1
        if new:
            self.db.execute(
                "INSERT INTO networks(bssid, ssid, channel, signal, encryption, "
                "first_seen, last_seen, lat, lon, whitelisted, band) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (bssid, ssid, channel, signal, encryption,
                 now, now, lat, lon, whitelisted, band or ""),
            )
            if not whitelisted:
                self.new_bssids_window += 1
        else:
            # NULLIF('', NULL) trick lets us update band only when we have
            # a non-empty value (some drivers don't always emit freq).
            self.db.execute(
                "UPDATE networks SET ssid=COALESCE(NULLIF(?, ''), ssid), "
                "channel=COALESCE(?, channel), signal=COALESCE(?, signal), "
                "encryption=COALESCE(?, encryption), last_seen=?, "
                "lat=COALESCE(?, lat), lon=COALESCE(?, lon), "
                "band=CASE WHEN ?='' THEN band ELSE ? END "
                "WHERE bssid=?",
                (ssid, channel, signal, encryption, now, lat, lon,
                 band or "", band or "", bssid),
            )
        self.db.commit()
        return new and not whitelisted

    def bssid_counts_by_band(self) -> dict:
        """Return non-whitelisted BSSID counts per band for the operator
        scope ({2g, 5g, 6g, unknown})."""
        cur = self.db.execute(
            "SELECT band, COUNT(*) FROM networks WHERE whitelisted=0 GROUP BY band"
        )
        out = {"2g": 0, "5g": 0, "6g": 0, "unknown": 0}
        for band, n in cur.fetchall():
            if band in out:
                out[band] = int(n)
            else:
                out["unknown"] += int(n)
        return out

    def add_packets(self, n: int, bytes_: int = 0) -> None:
        if n <= 0 and bytes_ <= 0:
            return
        if n > 0:
            self.db.execute(
                "UPDATE counters SET value=value+? WHERE name='packets'", (n,)
            )
            self.packets_window += n
        if bytes_ > 0:
            self.db.execute(
                "UPDATE counters SET value=value+? WHERE name='pcap_bytes'", (bytes_,)
            )
        self.db.commit()

    def add_rf_signals(self, n: int) -> None:
        if n <= 0:
            return
        self.rf_signals_total += n
        self.rf_signals_window += n

    def decay_window(self, dt: float) -> None:
        # Exponential decay so the speedometer eases back down when
        # captures stop coming in.
        decay = math.exp(-dt / 6.0)
        self.new_bssids_window *= decay
        self.packets_window *= decay
        # SDR sweeps run on a slower cadence; longer half-life so they
        # don't drop off the score before the next sweep arrives.
        self.rf_signals_window *= math.exp(-dt / 30.0)

    def speed_mph(self) -> float:
        # Composite "score speed": new networks weigh heavier than packets,
        # GPS movement adds a real-world boost, and ambient RF from the SDR
        # contributes a small steady push.
        bssid_term = self.new_bssids_window * 8.0
        pkt_term = min(self.packets_window * 0.05, 40.0)
        rf_term = min(self.rf_signals_window * 0.1, 20.0)
        gps_term = self.gps.speed_mps * 2.237 if self.gps.have_fix else 0.0
        # Idle speed so the car always rolls a bit.
        base = 4.0
        total = base + bssid_term + pkt_term + rf_term + gps_term
        return float(min(total, 220.0))

    # ---- LoRa fleet helpers ----
    def update_fleet_member(self, crew_id: str, beacon: dict) -> None:
        beacon = dict(beacon)
        beacon["last_seen"] = time.time()
        self.fleet[crew_id] = beacon

    def prune_fleet(self, timeout_s: float) -> None:
        now = time.time()
        stale = [cid for cid, b in self.fleet.items()
                 if now - b.get("last_seen", 0) > timeout_s]
        for cid in stale:
            self.fleet.pop(cid, None)


STATE = State()
