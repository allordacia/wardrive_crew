#!/bin/sh
# wardrive_crew entrypoint
#
# - Generates a self-signed TLS cert into $WARDRIVE_CERT_DIR on first boot
#   so the browser treats the origin as secure (required for the Geolocation
#   API, since it's blocked on plain http:// LAN origins).
# - Launches uvicorn with --ssl-* flags when WARDRIVE_HTTPS=1.

set -e

CERT_DIR="${WARDRIVE_CERT_DIR:-/data/certs}"
PORT="${WARDRIVE_PORT:-8443}"
HTTPS="${WARDRIVE_HTTPS:-1}"

mkdir -p "$CERT_DIR"
CRT="$CERT_DIR/server.crt"
KEY="$CERT_DIR/server.key"

if [ "$HTTPS" = "1" ] && [ ! -f "$CRT" ]; then
    echo "[entrypoint] generating self-signed TLS cert in $CERT_DIR"
    openssl req -x509 \
        -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
        -days 3650 -nodes \
        -subj "/CN=wardrive-crew" \
        -addext "subjectAltName=DNS:wardrive-crew,DNS:localhost,IP:127.0.0.1" \
        -keyout "$KEY" -out "$CRT" >/dev/null 2>&1
    chmod 600 "$KEY"
fi

if [ "$HTTPS" = "1" ]; then
    echo "[entrypoint] HTTPS on :$PORT (self-signed cert; accept the browser warning once)"
    exec uvicorn app.main:app --host 0.0.0.0 --port "$PORT" \
        --ssl-keyfile "$KEY" --ssl-certfile "$CRT"
else
    echo "[entrypoint] HTTP on :$PORT (Geolocation API will be blocked unless localhost)"
    exec uvicorn app.main:app --host 0.0.0.0 --port "$PORT"
fi
