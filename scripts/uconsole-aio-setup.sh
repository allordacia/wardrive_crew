#!/usr/bin/env bash
# wardrive_crew: one-shot host-side setup for uConsole + Hackergadgets AIO v2.
#
#   - Detects CM4 vs CM5 to pick the right GPS UART path
#   - Ensures enable_uart=1 in /boot/firmware/config.txt
#   - Removes any console=serial0,... from /boot/firmware/cmdline.txt so the
#     kernel stops trying to drive the GPS UART
#   - Powers on the GPS rail (via aiov2_ctl if installed; otherwise prints
#     the pinctrl fallback)
#   - Detects the AIO v2 wifi (MT7921AUN) iface name for WARDRIVE_IFACE
#   - Prints the docker-compose command to run next
#
# Run as a regular user; will prompt for sudo only when it needs to edit
# boot files.
#
#   ./scripts/uconsole-aio-setup.sh           # apply
#   ./scripts/uconsole-aio-setup.sh --dry-run # show what would change

set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

CONFIG=/boot/firmware/config.txt
CMDLINE=/boot/firmware/cmdline.txt

# Some older Pi OS layouts use /boot directly.
[[ -f "$CONFIG"  ]] || CONFIG=/boot/config.txt
[[ -f "$CMDLINE" ]] || CMDLINE=/boot/cmdline.txt

note()  { printf "  \033[1;36m%s\033[0m %s\n" "$1" "$2"; }
ok()    { note "✓" "$1"; }
warn()  { note "✗" "$1"; }
info()  { note "ℹ" "$1"; }

# --- 1. board detection -----------------------------------------------------
GPS_DEV=/dev/ttyS0
BOARD=CM4
if [[ -r /proc/device-tree/compatible ]]; then
    DT=$(tr '\0' '\n' </proc/device-tree/compatible)
    if grep -q "bcm2712" <<<"$DT"; then
        BOARD=CM5
        GPS_DEV=/dev/ttyAMA0
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
if command -v aiov2_ctl >/dev/null 2>&1; then
    info "aiov2_ctl present — enabling GPS rail"
    if (( DRY_RUN == 0 )); then
        aiov2_ctl gps on || warn "aiov2_ctl gps on returned non-zero"
    fi
else
    info "aiov2_ctl not found — install:"
    info "  pip install --user git+https://github.com/hackergadgets/aiov2_ctl"
    info "or pull the GPS GPIO high manually with: sudo pinctrl set <pin> op dh"
fi

# --- 5. MT7921 wifi iface ---------------------------------------------------
MT_IFACE=
if command -v iw >/dev/null 2>&1; then
    while read -r iface; do
        [[ -z "$iface" ]] && continue
        # Pick the first non-wlan0 wireless interface — that's the AIO MT7921
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

# --- 6. summary -------------------------------------------------------------
cat <<EOF

=========================================================================
  next steps
=========================================================================
  1. Reboot if anything in $CONFIG / $CMDLINE was changed:
       sudo reboot

  2. Confirm NMEA is flowing once the GPS rail is up:
       sudo cat $GPS_DEV
       (should see lines starting with \$GNRMC / \$GNGGA / \$GNGSA …)

  3. Bring up wardrive_crew with the uConsole overlay:

       cd $(pwd)
       WARDRIVE_IFACE=$MT_IFACE \\
       WARDRIVE_GPS_DEVICE=$GPS_DEV \\
       docker compose -f docker-compose.yml -f docker-compose.uconsole.yml up --build

  4. Open https://localhost:8443/ in the uConsole's browser. The GPS button
     in the UI is no longer needed — the server reads the AIO GPS directly.
=========================================================================
EOF
