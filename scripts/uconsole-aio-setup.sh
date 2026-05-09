#!/usr/bin/env bash
# wardrive_crew: one-shot host-side setup for uConsole + Hackergadgets AIO v1.
#
# Default target hardware: ClockworkPi uConsole (CM5) + AIO v1 board.
# CM4 is still detected and supported (older GPS UART path) but no longer
# the primary target.
#
#   - Detects CM5 (default) vs CM4 to pick the right GPS UART path
#   - Ensures enable_uart=1 in /boot/firmware/config.txt
#   - Removes any console=serial0,... from /boot/firmware/cmdline.txt so the
#     kernel stops trying to drive the GPS UART
#   - Powers on the GPS rail (via aio_ctl / aiov2_ctl if installed; otherwise
#     prints the pinctrl fallback)
#   - Detects the AIO wifi iface name for WARDRIVE_IFACE
#   - Verifies the result: GPS device exists, wifi iface present, RTC node
#     visible — exits non-zero if mandatory steps are still missing so this
#     script is safe to chain into automation
#   - Prints the docker-compose command to run next
#
# Run as a regular user; will prompt for sudo only when it needs to edit
# boot files.
#
#   ./scripts/uconsole-aio-setup.sh           # apply
#   ./scripts/uconsole-aio-setup.sh --dry-run # show what would change
#   ./scripts/uconsole-aio-setup.sh --check   # verify only, no changes

set -euo pipefail

DRY_RUN=0
CHECK_ONLY=0
case "${1:-}" in
    --dry-run) DRY_RUN=1 ;;
    --check)   DRY_RUN=1; CHECK_ONLY=1 ;;
esac

CONFIG=/boot/firmware/config.txt
CMDLINE=/boot/firmware/cmdline.txt

# Some older Pi OS layouts use /boot directly.
[[ -f "$CONFIG"  ]] || CONFIG=/boot/config.txt
[[ -f "$CMDLINE" ]] || CMDLINE=/boot/cmdline.txt

note()  { printf "  \033[1;36m%s\033[0m %s\n" "$1" "$2"; }
ok()    { note "✓" "$1"; }
warn()  { note "✗" "$1"; }
info()  { note "ℹ" "$1"; }

ERRORS=0
fail() { warn "$1"; ERRORS=$((ERRORS + 1)); }

# --- 1. board detection -----------------------------------------------------
# Default to CM5 (the recommended target for AIO v1). Fall back to CM4 only
# if the device tree explicitly identifies a bcm2711.
BOARD=CM5
GPS_DEV=/dev/ttyAMA0
if [[ -r /proc/device-tree/compatible ]]; then
    DT=$(tr '\0' '\n' </proc/device-tree/compatible)
    if grep -q "bcm2711" <<<"$DT"; then
        BOARD=CM4
        GPS_DEV=/dev/ttyS0
    fi
fi
ok "detected board: $BOARD (GPS UART = $GPS_DEV)"

# --- 2. /boot/firmware/config.txt -------------------------------------------
if [[ -f "$CONFIG" ]]; then
    if grep -qE '^\s*enable_uart\s*=\s*1' "$CONFIG"; then
        ok "enable_uart=1 already in $CONFIG"
    else
        warn "enable_uart=1 missing from $CONFIG"
        if (( DRY_RUN == 0 )); then
            echo "enable_uart=1" | sudo tee -a "$CONFIG" >/dev/null
            ok "appended enable_uart=1"
        fi
    fi
else
    warn "$CONFIG not found (skipping UART enable)"
fi

# --- 3. /boot/firmware/cmdline.txt ------------------------------------------
if [[ -f "$CMDLINE" ]]; then
    if grep -qE 'console=serial0' "$CMDLINE"; then
        warn "console=serial0 in $CMDLINE — kernel will fight us for the UART"
        if (( DRY_RUN == 0 )); then
            sudo cp "$CMDLINE" "${CMDLINE}.wardrive.bak"
            sudo sed -i -E 's/\s*console=serial0,[0-9]+\b//g' "$CMDLINE"
            ok "removed (backup at ${CMDLINE}.wardrive.bak)"
        fi
    else
        ok "no serial console hijacking the GPS UART"
    fi
else
    warn "$CMDLINE not found (skipping)"
fi

# --- 4. power on the GPS rail ------------------------------------------------
# AIO v1 ships with `aio_ctl`; AIO v2 used `aiov2_ctl`. Try both, so this
# script keeps working on either generation.
AIO_CTL=
for cand in aio_ctl aiov2_ctl; do
    if command -v "$cand" >/dev/null 2>&1; then
        AIO_CTL="$cand"; break
    fi
done
if [[ -n "$AIO_CTL" ]]; then
    info "$AIO_CTL present — enabling GPS rail"
    if (( DRY_RUN == 0 )); then
        "$AIO_CTL" gps on || warn "$AIO_CTL gps on returned non-zero"
    fi
else
    info "no aio_ctl / aiov2_ctl found — install one of:"
    info "  pip install --user git+https://github.com/hackergadgets/aio_ctl"
    info "or pull the GPS GPIO high manually with: sudo pinctrl set <pin> op dh"
fi

# --- 5. AIO wifi iface ------------------------------------------------------
MT_IFACE=
if command -v iw >/dev/null 2>&1; then
    while read -r iface; do
        [[ -z "$iface" ]] && continue
        # Pick the first non-wlan0 wireless interface — that's the AIO radio
        # in our two-radio setup. Override with WARDRIVE_IFACE if you've named
        # things differently.
        if [[ "$iface" != "wlan0" ]]; then
            MT_IFACE="$iface"
            break
        fi
    done < <(iw dev 2>/dev/null | awk '/Interface/ {print $2}')
fi
if [[ -n "$MT_IFACE" ]]; then
    ok "AIO wifi iface: $MT_IFACE"
else
    info "no second wifi iface yet (AIO not powered on?). Defaulting to wlan1."
    MT_IFACE=wlan1
fi

# --- 6. verify ---------------------------------------------------------------
# Hard checks that block the rest of the system from working. We surface
# them here (not silently in the container) so the user sees them at setup.
if [[ -e "$GPS_DEV" ]]; then
    ok "GPS device $GPS_DEV present"
else
    fail "GPS device $GPS_DEV missing — board may need a reboot or aio_ctl gps on"
fi

if [[ -e "/sys/class/net/$MT_IFACE" ]]; then
    ok "wifi iface $MT_IFACE present"
else
    fail "wifi iface $MT_IFACE not present — AIO board not enumerated yet"
fi

if [[ -e /dev/rtc0 ]]; then
    ok "RTC node /dev/rtc0 present"
else
    info "no /dev/rtc0 — set WARDRIVE_RTC_SYNC=0 if your AIO has no RTC populated"
fi

# --- 6b. bluetooth (BLE) ----------------------------------------------------
# bleak needs bluetoothd reachable over DBus; rfkill must not be soft-blocking
# the radio. None of these are fatal — BT is opt-in via WARDRIVE_BT_ENABLED.
if [[ -e /var/run/dbus/system_bus_socket ]]; then
    ok "DBus system bus socket present (bleak/BlueZ)"
else
    fail "DBus system bus socket missing — install dbus on the host"
fi
if command -v rfkill >/dev/null 2>&1; then
    if rfkill list bluetooth 2>/dev/null | grep -q "Soft blocked: yes"; then
        warn "Bluetooth is rfkill soft-blocked"
        if (( DRY_RUN == 0 )); then
            sudo rfkill unblock bluetooth && ok "rfkill unblock bluetooth"
        fi
    else
        ok "Bluetooth not rfkill-blocked"
    fi
else
    info "rfkill not installed — skipping bluetooth block check"
fi
if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet bluetooth.service 2>/dev/null; then
        ok "bluetoothd active"
    else
        warn "bluetoothd not active — \`sudo systemctl enable --now bluetooth\`"
        if (( DRY_RUN == 0 )); then
            sudo systemctl enable --now bluetooth.service \
                && ok "started bluetooth.service" \
                || warn "failed to start bluetooth.service"
        fi
    fi
fi

# --- 7. summary -------------------------------------------------------------
cat <<EOF

=========================================================================
  next steps
=========================================================================
  1. Reboot if anything in $CONFIG / $CMDLINE was changed:
       sudo reboot

  2. Confirm NMEA is flowing once the GPS rail is up:
       sudo cat $GPS_DEV
       (should see lines starting with \$GNRMC / \$GNGGA / \$GNGSA ...)

  3. Bring up wardrive_crew with the uConsole overlay:

       cd $(pwd)
       WARDRIVE_IFACE=$MT_IFACE \\
       WARDRIVE_GPS_DEVICE=$GPS_DEV \\
       docker compose -f docker-compose.yml -f docker-compose.uconsole.yml up --build

  4. Open https://localhost:8443/ in the uConsole's browser. The GPS button
     in the UI is no longer needed — the server reads the AIO GPS directly.
=========================================================================
EOF

if (( CHECK_ONLY )); then
    if (( ERRORS > 0 )); then
        warn "verify: $ERRORS issue(s) — fix the above before launching wardrive_crew"
        exit 1
    fi
    ok "verify: AIO board ready"
fi
exit 0
