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
            targeted INTEGER NOT NULL DEFAULT 0
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
            targeted INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS counters (
            name TEXT PRIMARY KEY,
            value INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        -- Per-target observation history (RSSI / GPS breadcrumb). Pruned
        -- to OBS_KEEP_PER_TARGET on insert so the table doesn't grow
        -- without bound on long sessions.
        CREATE TABLE IF NOT EXISTS network_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bssid TEXT NOT NULL,
            ts REAL NOT NULL,
            signal INTEGER,
            channel INTEGER,
            lat REAL,
            lon REAL
        );
        CREATE INDEX IF NOT EXISTS idx_netobs_bssid_ts
            ON network_observations(bssid, ts);
        CREATE TABLE IF NOT EXISTS bt_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mac TEXT NOT NULL,
            ts REAL NOT NULL,
            rssi INTEGER,
            lat REAL,
            lon REAL
        );
        CREATE INDEX IF NOT EXISTS idx_btobs_mac_ts
            ON bt_observations(mac, ts);
        INSERT OR IGNORE INTO counters(name, value) VALUES ('packets', 0);
        INSERT OR IGNORE INTO counters(name, value) VALUES ('pcap_bytes', 0);
        """
    )
    # Column migrations for dbs created before these columns existed.
    cols = {row[1] for row in conn.execute("PRAGMA table_info(networks)").fetchall()}
    if "whitelisted" not in cols:
        conn.execute("ALTER TABLE networks ADD COLUMN whitelisted INTEGER NOT NULL DEFAULT 0")
    if "targeted" not in cols:
        conn.execute("ALTER TABLE networks ADD COLUMN targeted INTEGER NOT NULL DEFAULT 0")
    if "notes" not in cols:
        conn.execute("ALTER TABLE networks ADD COLUMN notes TEXT NOT NULL DEFAULT ''")
    bt_cols = {row[1] for row in conn.execute("PRAGMA table_info(bt_devices)").fetchall()}
    if "notes" not in bt_cols:
        conn.execute("ALTER TABLE bt_devices ADD COLUMN notes TEXT NOT NULL DEFAULT ''")
    conn.commit()
    return conn


# Cap observations per target so a long session doesn't bloat the DB. Pruned
# on insert.
OBS_KEEP_PER_TARGET = 500


@dataclass
class GpsFix:
    lat: float = 0.0
    lon: float = 0.0
    speed_mps: float = 0.0
    accuracy_m: float = 0.0
    ts: float = 0.0
    have_fix: bool = False
    source: str = "none"     # "serial" | "browser" | "none"
    sat_count: int = 0
    hdop: float = 0.0


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
    ) -> bool:
        """Insert/update a BLE device. Returns True if it was new."""
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
                "first_seen, last_seen, lat, lon) VALUES (?,?,?,?,?,?,?,?)",
                (mac, name, rssi, manufacturer, now, now, lat, lon),
            )
        else:
            # Only overwrite name/manufacturer when we actually heard something
            # informative — many BLE adverts come anonymous.
            self.db.execute(
                "UPDATE bt_devices SET "
                "name=COALESCE(NULLIF(?, ''), name), "
                "rssi=COALESCE(?, rssi), "
                "manufacturer=COALESCE(NULLIF(?, ''), manufacturer), "
                "last_seen=?, "
                "lat=COALESCE(?, lat), lon=COALESCE(?, lon) "
                "WHERE mac=?",
                (name, rssi, manufacturer, now, lat, lon, mac),
            )
        # Same as wifi: record observations only for targeted devices.
        cur = self.db.execute("SELECT targeted FROM bt_devices WHERE mac=?", (mac,))
        row = cur.fetchone()
        if row and row[0]:
            self.db.execute(
                "INSERT INTO bt_observations(mac, ts, rssi, lat, lon) "
                "VALUES (?, ?, ?, ?, ?)",
                (mac, now, rssi, lat, lon),
            )
            self._prune_bt_obs(mac)
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
            "whitelisted, targeted "
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
            })
        return out

    def bt_devices_total(self) -> int:
        cur = self.db.execute("SELECT COUNT(*) FROM bt_devices WHERE whitelisted=0")
        return int(cur.fetchone()[0])

    def bt_targets_total(self) -> int:
        cur = self.db.execute("SELECT COUNT(*) FROM bt_devices WHERE targeted=1")
        return int(cur.fetchone()[0])

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
    ) -> bool:
        """Insert/update network. Returns True if it was new."""
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
                "first_seen, last_seen, lat, lon, whitelisted) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (bssid, ssid, channel, signal, encryption, now, now, lat, lon, whitelisted),
            )
            if not whitelisted:
                self.new_bssids_window += 1
        else:
            self.db.execute(
                "UPDATE networks SET ssid=COALESCE(NULLIF(?, ''), ssid), "
                "channel=COALESCE(?, channel), signal=COALESCE(?, signal), "
                "encryption=COALESCE(?, encryption), last_seen=?, "
                "lat=COALESCE(?, lat), lon=COALESCE(?, lon) WHERE bssid=?",
                (ssid, channel, signal, encryption, now, lat, lon, bssid),
            )
        # Record an observation for *targeted* networks only. Recording every
        # heard BSSID would balloon the DB; the trail is only useful for
        # devices the operator is actively tracking.
        cur = self.db.execute("SELECT targeted FROM networks WHERE bssid=?", (bssid,))
        row = cur.fetchone()
        if row and row[0]:
            self.db.execute(
                "INSERT INTO network_observations(bssid, ts, signal, channel, lat, lon) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (bssid, now, signal, channel, lat, lon),
            )
            self._prune_network_obs(bssid)
        self.db.commit()
        return new and not whitelisted

    def _prune_network_obs(self, bssid: str) -> None:
        self.db.execute(
            "DELETE FROM network_observations WHERE bssid=? AND id NOT IN ("
            "SELECT id FROM network_observations WHERE bssid=? "
            "ORDER BY ts DESC LIMIT ?)",
            (bssid, bssid, OBS_KEEP_PER_TARGET),
        )

    def _prune_bt_obs(self, mac: str) -> None:
        self.db.execute(
            "DELETE FROM bt_observations WHERE mac=? AND id NOT IN ("
            "SELECT id FROM bt_observations WHERE mac=? "
            "ORDER BY ts DESC LIMIT ?)",
            (mac, mac, OBS_KEEP_PER_TARGET),
        )

    def network_trail(self, bssid: str, limit: int = 200) -> list[dict]:
        cur = self.db.execute(
            "SELECT ts, signal, channel, lat, lon FROM network_observations "
            "WHERE bssid=? ORDER BY ts DESC LIMIT ?",
            ((bssid or "").lower(), max(1, min(limit, 1000))),
        )
        return [
            {"ts": r[0], "signal": r[1], "channel": r[2], "lat": r[3], "lon": r[4]}
            for r in cur.fetchall()
        ]

    def bt_trail(self, mac: str, limit: int = 200) -> list[dict]:
        cur = self.db.execute(
            "SELECT ts, rssi, lat, lon FROM bt_observations "
            "WHERE mac=? ORDER BY ts DESC LIMIT ?",
            ((mac or "").lower(), max(1, min(limit, 1000))),
        )
        return [
            {"ts": r[0], "rssi": r[1], "lat": r[2], "lon": r[3]}
            for r in cur.fetchall()
        ]

    def set_network_notes(self, bssid: str, notes: str) -> bool:
        cur = self.db.execute(
            "UPDATE networks SET notes=? WHERE bssid=?",
            (notes or "", (bssid or "").lower()),
        )
        self.db.commit()
        return cur.rowcount > 0

    def set_bt_notes(self, mac: str, notes: str) -> bool:
        cur = self.db.execute(
            "UPDATE bt_devices SET notes=? WHERE mac=?",
            (notes or "", (mac or "").lower()),
        )
        self.db.commit()
        return cur.rowcount > 0

    def network_detail(self, bssid: str) -> dict | None:
        cur = self.db.execute(
            "SELECT bssid, ssid, channel, signal, encryption, first_seen, "
            "last_seen, lat, lon, whitelisted, targeted, notes "
            "FROM networks WHERE bssid=?",
            ((bssid or "").lower(),),
        )
        r = cur.fetchone()
        if not r:
            return None
        return {
            "bssid": r[0], "ssid": r[1], "channel": r[2], "signal": r[3],
            "encryption": r[4], "first_seen": r[5], "last_seen": r[6],
            "lat": r[7], "lon": r[8],
            "whitelisted": bool(r[9]), "targeted": bool(r[10]),
            "notes": r[11] or "",
        }

    def bt_detail(self, mac: str) -> dict | None:
        cur = self.db.execute(
            "SELECT mac, name, rssi, manufacturer, first_seen, last_seen, "
            "lat, lon, whitelisted, targeted, notes "
            "FROM bt_devices WHERE mac=?",
            ((mac or "").lower(),),
        )
        r = cur.fetchone()
        if not r:
            return None
        return {
            "mac": r[0], "name": r[1] or "", "rssi": r[2],
            "manufacturer": r[3] or "",
            "first_seen": r[4], "last_seen": r[5],
            "lat": r[6], "lon": r[7],
            "whitelisted": bool(r[8]), "targeted": bool(r[9]),
            "notes": r[10] or "",
        }

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
