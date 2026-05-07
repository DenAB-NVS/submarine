#!/bin/bash
# Installing systemd service for submarine
# ⚠ Requires sudo

set -e

SERVICE_NAME="submarine"
SERVICE_FILE="$(dirname "$0")/submarine.service"
DEST="/etc/systemd/system/${SERVICE_NAME}.service"

echo "🚢 Installing submarine service..."
echo ""

if [ ! -f "$SERVICE_FILE" ]; then
    echo "❌ ${SERVICE_FILE} not found"
    exit 1
fi

if [ "$EUID" -ne 0 ]; then
    echo "⚠  Requires sudo. Run: sudo bash install-service.sh"
    exit 1
fi

cp "$SERVICE_FILE" "$DEST"
echo "✅ Copied to $DEST"

systemctl daemon-reload
echo "✅ systemd reloaded"

systemctl enable "$SERVICE_NAME"
echo "✅ Service enabled (autostart)"

systemctl start "$SERVICE_NAME"
echo "✅ Service started"

echo ""
systemctl status "$SERVICE_NAME" --no-pager
echo ""
echo "📝 Logs: journalctl -u $SERVICE_NAME -f"
echo "🔄 Restart: sudo systemctl restart $SERVICE_NAME"
