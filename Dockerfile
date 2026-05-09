FROM python:3.12-slim

# Wireless tooling: iw for managed-mode scanning + monitor-mode flips,
# wireless-tools as fallback, iproute2 for `ip link`, wpasupplicant so
# managed mode can auth against the parent network if needed,
# wireshark-common gives us dumpcap (preferred over tcpdump for rotation),
# tcpdump kept as backup. aircrack-ng for airmon-ng if users want it.
RUN apt-get update && apt-get install -y --no-install-recommends \
        iw \
        iproute2 \
        wireless-tools \
        wpasupplicant \
        tcpdump \
        wireshark-common \
        tshark \
        aircrack-ng \
        openssl \
        ca-certificates \
        procps \
        util-linux \
        rtl-sdr \
        librtlsdr0 \
        rtl-433 \
        bluez \
        bluez-tools \
        dbus \
        rfkill \
    && rm -rf /var/lib/apt/lists/*

# dumpcap needs to run as non-root in the wireshark group normally; we run
# the container as root by default since wireless ops require it anyway.

WORKDIR /srv
COPY requirements.txt /srv/
RUN pip install --no-cache-dir -r requirements.txt

COPY app /srv/app
COPY entrypoint.sh /srv/entrypoint.sh
RUN chmod +x /srv/entrypoint.sh

VOLUME ["/data"]
ENV WARDRIVE_IFACE=wlan0 \
    WARDRIVE_SCAN_INTERVAL=8 \
    WARDRIVE_AUTO_MONITOR=0 \
    WARDRIVE_USE_AIRMON=1 \
    WARDRIVE_KILL_INTERFERING=1 \
    WARDRIVE_HTTPS=1 \
    WARDRIVE_PORT=8443 \
    WARDRIVE_LOG_LEVEL=INFO

EXPOSE 8443
ENTRYPOINT ["/srv/entrypoint.sh"]
