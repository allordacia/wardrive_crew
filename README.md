# wardrive_crew :: terminal

A dockerized war-driving rig with an 80s-hacker / cyberpunk operator
terminal on the front. Default target hardware: **ClockworkPi uConsole
(CM5) + Hackergadgets AIO v1**.

Open the page on the device, get a CRT-style scope: a phosphor-green
radar PPI sweeping for new BSSIDs, a live spectrum bargraph for the
SDR, a scrolling sniff log, and a status bus showing every radio in the
stack. Every new BSSID, every captured packet, every GPS-measured mph
turns into a blip on the scope. No mascots, no game elements, just a
panel-and-rivets operator console.

## What it does

- **Active scan** of nearby wifi using `iw dev <iface> scan` (no monitor
  mode required).
- **Optional monitor mode + pcap capture** toggled from the terminal
  ([F1] MONITOR). Flips the adapter to monitor with `iw`, starts
  `dumpcap` with file rotation into `./data/pcaps/`.
- **GPS** — either the AIO's onboard GNSS via NMEA on the UART (default
  on the uConsole build) or the host browser's W3C Geolocation API via
  the [F2] GPS button.
- **WebSocket-driven scope** pushes live network/packet/RF/speed numbers
  to the page at 4 Hz. The radar sweep, the spectrum bars, and the sniff
  log all react to those snapshots.
- **CRT chrome** — phosphor scanlines, ASCII frames, blinking cursor,
  monospace everywhere. One renderer, no mode switch, no presets.

## Hardware

You need a wifi adapter the host can use. For monitor mode + pcap, the
adapter's chipset/driver must support it. The recommended build's AIO
radio supports it; other good chipsets include Atheros AR9271, Ralink
RT3070/RT5370, Realtek RTL8812AU/RTL8814AU, and some Intel cards with
the right kmod. The container itself doesn't add monitor capability —
it just flips whatever the host kernel already supports.

## Run it

### Recommended: uConsole + Hackergadgets AIO v1

This is the default target. The setup script handles UART freeing, GPS
rail power, and wifi-iface detection in one shot, then verifies that
the board is actually ready before you launch.

```bash
# Run once on the host (CM5 detected by default; CM4 supported as fallback):
./scripts/uconsole-aio-setup.sh
sudo reboot          # only if config.txt or cmdline.txt got edited

# Verify after reboot — non-zero exit if anything's still wrong:
./scripts/uconsole-aio-setup.sh --check

# Then bring it up with the uConsole overlay (defaults to CM5 GPS path):
docker compose -f docker-compose.yml -f docker-compose.uconsole.yml up --build
```

For an older CM4 + AIO board, override:

```bash
WARDRIVE_GPS_DEVICE=/dev/ttyS0 \
docker compose -f docker-compose.yml -f docker-compose.uconsole.yml up --build
```

When `WARDRIVE_GPS_DEVICE` is set the server reads NMEA directly off the
UART — the [F2] GPS button is no longer needed.

The container also runs an AIO sanity check on startup (the same probes
the setup script does in `--check` mode). Any issue shows up in the
operator terminal's status line and in the container logs, so you don't
have to ssh in to figure out why GPS isn't coming up.

### Generic / non-uConsole

```bash
# 1. Plug in your wifi adapter, find its name:
ip -o link | awk -F': ' '/wl/ {print $2}'   # e.g. wlan0, wlan1, wlx00...

# 2. Build + run
WARDRIVE_IFACE=wlan0 docker compose up --build
```

Open `https://<host>:8443/` on the device you want to use. The container
generates a self-signed cert on first boot — your browser will warn
about it; click "Advanced" -> "Proceed". HTTPS is **required** because
the W3C Geolocation API is blocked on plain `http://` LAN origins, so
the [F2] GPS button only works under HTTPS. (When the AIO GPS is wired
up via UART you can disable HTTPS with `WARDRIVE_HTTPS=0`.)

If you're driving around with a phone, hit [F2] to grant location and
start streaming fixes back to the box. Hit [F1] to flip the adapter
into monitor mode (via `airmon-ng`) and start rotating pcaps into
`./data/pcaps/`. Hit [F3] to open the CONFIG modal and whitelist
networks you don't want to count toward the score (e.g. your own home
AP).

### Environment variables

| Variable                    | Default          | Notes                                                                        |
|-----------------------------|------------------|------------------------------------------------------------------------------|
| `WARDRIVE_IFACE`            | `wlan1`          | Wireless interface on the host (AIO board on uConsole). `wlan0` for stand-alone adapters.|
| `WARDRIVE_SCAN_INTERVAL`    | `8`              | Seconds between active scans (managed mode only).                            |
| `WARDRIVE_AUTO_MONITOR`     | `0`              | Set to `1` to start in monitor + pcap on boot.                               |
| `WARDRIVE_USE_AIRMON`       | `1`              | Use `airmon-ng start` (creates `wlanXmon`). `0` = plain `iw set type monitor`. |
| `WARDRIVE_KILL_INTERFERING` | `1`              | Run `airmon-ng check kill` first so NetworkManager / wpa_supplicant let go.  |
| `WARDRIVE_HTTPS`            | `1`              | Serve HTTPS (required for browser Geolocation on a LAN IP).                  |
| `WARDRIVE_PORT`             | `8443`           | Port to listen on.                                                           |
| `WARDRIVE_GPS_DEVICE`       | `/dev/ttyAMA0`*  | NMEA serial device. *uConsole overlay default; unset on the base compose.    |
| `WARDRIVE_GPS_BAUD`         | `9600`           | Serial baud rate for the GPS UART.                                           |
| `WARDRIVE_RTC_SYNC`         | `1`*             | `hwclock -s` from `/dev/rtc0` at startup. *uConsole overlay default; `0` on base.|
| `WARDRIVE_SDR_ENABLED`      | `1`*             | `1` to run the RTL-SDR `rtl_power` sweep loop. *uConsole overlay default; `0` on base.|
| `WARDRIVE_SDR_BANDS`        | ISM+ADSB         | Comma list of `rtl_power -f` bands (e.g. `"433M:435M,868M:870M"`).           |
| `WARDRIVE_SDR_INTERVAL`     | `60`             | Seconds between SDR sweep cycles.                                            |
| `WARDRIVE_SDR_THRESHOLD`    | `-40`            | dBm threshold for "peak" bins.                                               |
| `WARDRIVE_LORA_DEVICE`      | unset            | Meshtastic serial device (e.g. `/dev/ttyACM0`); enables LoRa fleet beacons.  |
| `WARDRIVE_CREW_ID`          | random           | Short crew name broadcast in LoRa beacons (auto-generated if absent).        |
| `WARDRIVE_LORA_INTERVAL`    | `30`             | Seconds between LoRa beacons.                                                |
| `WARDRIVE_BT_ENABLED`       | `1`*             | Run the BLE scan loop. *uConsole overlay default; `0` on base.               |
| `WARDRIVE_BT_INTERVAL`      | `8`              | Seconds per BLE scan window.                                                 |
| `WARDRIVE_BT_ADAPTER`       | `hci0`*          | HCI adapter name; *unset on base compose.                                    |
| `WARDRIVE_LOG_LEVEL`        | `INFO`           | Python logging level.                                                        |

The wifi interface can also be selected at runtime from the **CONFIG**
modal ([F3]). The picker lists every `wireless/` device under
`/sys/class/net` and the active selection is persisted in the SQLite
settings table — your choice survives container restarts and overrides
`WARDRIVE_IFACE` on subsequent boots. Switching is refused while
monitor mode is on; turn it off first with [F1].

### AIO peripherals

When the matching env var is set:

- **RTC (PCF85063A)** — system time is pulled from the battery-backed
  RTC at startup so timestamps stay coherent across cold boots while
  mobile/offline. Surfaces as the `[ RTC ]` flag in the status bus.
- **RTL-SDR (RTL2832U + R860)** — periodic `rtl_power` sweep across the
  configured bands; each FFT bin above the dBm threshold is counted as
  an "RF signal" and contributes to the score. Each peak shows as a
  cyan blip on the radar plus a live bargraph in the `// SPEC` panel.
- **LoRa via Meshtastic (SX1262)** — broadcasts a small JSON beacon
  every N seconds on a private Meshtastic app port (`{crew_id, score,
  mph, lat, lon}`); incoming beacons from other crews running
  wardrive_crew populate `STATE.fleet` and show up as magenta blips on
  the radar. Requires the SX1262 to have Meshtastic firmware flashed
  (a one-time step done with the official Meshtastic CLI).
- **Bluetooth (BLE)** — passive advertisement scan via `bleak` over
  BlueZ on the host. Each heard device becomes a row in the
  `bt_devices` table, surfaced under the `BT.DEVICES` tab on the
  terminal with the same `[*]` whitelist / `[!]` target affordances as
  wifi. The container needs `/var/run/dbus` mounted from the host (the
  uConsole compose overlay does this) and `bluetoothd` running with
  `rfkill` not soft-blocking the radio — the AIO setup script
  (`scripts/uconsole-aio-setup.sh`) verifies and fixes both.

## Endpoints

- `GET  /`                -- the operator terminal page.
- `GET  /api/status`      -- JSON snapshot of state.
- `GET  /api/networks`    -- recent BSSIDs with last-seen GPS fix + whitelist/target flags.
- `PUT  /api/network/{bssid}` -- toggle `{whitelisted, targeted}` for a BSSID.
- `POST /api/gps`         -- `{lat, lon, speed_mps?, accuracy_m?}`.
- `POST /api/whitelist`   -- `{bssid|ssid, whitelisted}` toggle.
- `PUT  /api/whitelist`   -- `{bssids:[...], ssids:[...]}` replace the whitelist.
- `GET  /api/iface`       -- list host wireless interfaces + current selection.
- `PUT  /api/iface`       -- `{iface}` switch the active scanner interface (refused while monitor is on).
- `GET  /api/bt/devices`  -- recent BLE devices with whitelist/target flags.
- `PUT  /api/bt/{mac}`    -- toggle `{whitelisted, targeted}` for a BLE device.
- `POST /api/monitor/on` / `/api/monitor/off` -- toggle monitor + pcap.
- `WS   /ws`              -- live state stream for the terminal.

## Data layout

Inside the bind-mounted `./data/` volume:

```
data/
|- wardrive.sqlite    # networks + bt_devices + counters + settings
\- pcaps/             # rotated pcap files (only when monitor is on)
```

## Speed formula

```
mph = 4
    + 8 * (recent new BSSIDs, exponentially decayed over ~6s)
    + min(40, 0.05 * recent packet count)
    + 2.237 * gps.speed_mps        # actual movement speed
```

The numbers decay so the velocity readout eases back down when captures
stop. The terminal labels it `VEL`.

## Legal / be cool

Only use this on networks and in places where capturing is legal for
you. Active scanning (managed mode) is generally fine; monitor-mode
pcap of other people's traffic is **not** in many jurisdictions.
Default is scan-only -- monitor mode is opt-in.
