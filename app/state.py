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
            whitelisted INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS counters (
            name TEXT PRIMARY KEY,
            value INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        INSERT OR IGNORE INTO counters(name, value) VALUES ('packets', 0);
        INSERT OR IGNORE INTO counters(name, value) VALUES ('pcap_bytes', 0);
        """
    )
    # Migration for dbs created before the whitelisted column existed.
    cols = {row[1] for row in conn.execute("PRAGMA table_info(networks)").fetchall()}
    if "whitelisted" not in cols:
        conn.execute("ALTER TABLE networks ADD COLUMN whitelisted INTEGER NOT NULL DEFAULT 0")
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

    # ---- generic key/value settings (used by the scene preset picker) ----
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
        self.db.commit()
        return new and not whitelisted

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
