# wardrive_crew

A dockerized war-driving tool with a Game-&-Watch-style game on top.

Open a web page on the device, see a car packed with animals — a dog at
the wheel, a cat in the back, a parrot through the sunroof, and a raccoon
hanging out the hatch. The car cruises down a side-view LCD road. Every
new BSSID, every captured packet, every GPS-measured mph makes the car
roll faster. The wheels spin, the road dashes scroll, the antenna pulses
the more wifi you scoop up.

## What it does

- **Active scan** of nearby wifi using `iw dev <iface> scan` (no monitor
  mode required).
- **Optional monitor mode + pcap capture** toggled from the web UI.
  Flips the adapter to monitor with `iw`, starts `dumpcap` with file
  rotation into `./data/pcaps/`.
- **GPS from the host device's browser** via the W3C Geolocation API.
  No need for a serial GPS — the phone/tablet/laptop loading the page is
  the GPS source. Each new BSSID is stamped with the current fix.
- **WebSocket-driven HUD** pushes live network/packet/speed numbers to the
  page at 4 Hz.
- **LCD handheld animation** — every element has 2–4 fixed frames that
  toggle on a tick; tick rate scales with capture rate.

## Hardware

You need a wifi adapter the host can use. For monitor mode + pcap, the
adapter's chipset/driver must support it. Known-good chipsets include
Atheros AR9271, Ralink RT3070/RT5370, Realtek RTL8812AU/RTL8814AU, and
some Intel cards with the right kmod. The container itself doesn't add
monitor capability — it just flips whatever the host kernel already
supports.

## Run it

```bash
# 1. Plug in your wifi adapter, find its name:
ip -o link | awk -F': ' '/wl/ {print $2}'   # e.g. wlan0, wlan1, wlx00...

# 2. Build + run
WARDRIVE_IFACE=wlan0 docker compose up --build
```

Then open `https://<host>:8443/` on the device you want to use. The
container generates a self-signed cert on first boot — your browser
will warn about it; click "Advanced" → "Proceed". HTTPS is **required**
because the W3C Geolocation API is blocked on plain `http://` LAN
origins, so the GPS button only works under HTTPS.

If you're driving around with a phone, hit the **GPS** button on the
page to grant location and start streaming fixes back to the box. Hit
the **MONITOR** button to flip the adapter into monitor mode (via
`airmon-ng`) and start rotating pcaps into `./data/pcaps/`. Hit
**SETTINGS** to whitelist networks you don't want to count toward the
score (e.g. your own home AP).

### Environment variables

| Variable                    | Default | Notes                                                                        |
|-----------------------------|---------|------------------------------------------------------------------------------|
| `WARDRIVE_IFACE`            | `wlan0` | Wireless interface on the host.                                              |
| `WARDRIVE_SCAN_INTERVAL`    | `8`     | Seconds between active scans (managed mode only).                            |
| `WARDRIVE_AUTO_MONITOR`     | `0`     | Set to `1` to start in monitor + pcap on boot.                               |
| `WARDRIVE_USE_AIRMON`       | `1`     | Use `airmon-ng start` (creates `wlanXmon`). `0` = plain `iw set type monitor`. |
| `WARDRIVE_KILL_INTERFERING` | `1`     | Run `airmon-ng check kill` first so NetworkManager / wpa_supplicant let go.  |
| `WARDRIVE_HTTPS`            | `1`     | Serve HTTPS (required for Geolocation on a LAN IP).                          |
| `WARDRIVE_PORT`             | `8443`  | Port to listen on.                                                           |
| `WARDRIVE_LOG_LEVEL`        | `INFO`  | Python logging level.                                                        |

## Endpoints

- `GET  /`              — the LCD page.
- `GET  /api/status`    — JSON snapshot of state.
- `GET  /api/networks`  — recent BSSIDs with last-seen GPS fix + whitelist flag.
- `POST /api/gps`       — `{lat, lon, speed_mps?, accuracy_m?}`.
- `POST /api/whitelist` — `{bssid|ssid, whitelisted}` toggle.
- `PUT  /api/whitelist` — `{bssids:[…], ssids:[…]}` replace the whitelist.
- `POST /api/monitor/on` / `/api/monitor/off` — toggle monitor + pcap.
- `WS   /ws`            — live state stream for the HUD.

## Data layout

Inside the bind-mounted `./data/` volume:

```
data/
├── wardrive.sqlite    # bssid table + counters
└── pcaps/             # rotated pcap files (only when monitor is on)
```

## Speed formula

```
mph = 4
    + 8 * (recent new BSSIDs, exponentially decayed over ~6s)
    + min(40, 0.05 * recent packet count)
    + 2.237 * gps.speed_mps        # actual movement speed
```

The numbers decay so the speedometer eases back down when captures stop.

## Legal / be cool

Only use this on networks and in places where capturing is legal for you.
Active scanning (managed mode) is generally fine; monitor-mode pcap of
other people's traffic is **not** in many jurisdictions. Default is
scan-only — monitor mode is opt-in.
