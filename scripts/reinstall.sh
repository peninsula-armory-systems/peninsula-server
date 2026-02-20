#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo)."
  exit 1
fi

APP_DIR="/opt/peninsula-api"
PANEL_DIR="/var/www/peninsula-panel"
DB_NAME="peninsula"
DB_USER="peninsula"

echo "=========================================="
echo "FULL REINSTALLATION OF PENINSULA"
echo "=========================================="
echo ""
echo "⚠️  WARNING: This will delete:"
echo "   - The PostgreSQL database"
echo "   - Application files"
echo "   - Nginx and SSL configurations"
echo ""
read -p "Are you sure? (yes/no): " confirmation
if [[ "$confirmation" != "yes" ]]; then
  echo "Cancelled."
  exit 0
fi

echo ""
echo "[1/6] Stopping services..."
systemctl stop peninsula-api || true
systemctl stop nginx || true

echo "[2/6] Deleting database..."
sudo -u postgres psql -c "DROP DATABASE IF EXISTS $DB_NAME;" || true
sudo -u postgres psql -c "DROP USER IF EXISTS $DB_USER;" || true

echo "[3/6] Deleting application files..."
rm -rf "$APP_DIR"
rm -rf "$PANEL_DIR"

echo "[4/6] Deleting systemd and nginx configurations..."
rm -f /etc/systemd/system/peninsula-api.service
rm -f /etc/nginx/sites-available/peninsula
rm -f /etc/nginx/sites-enabled/peninsula
systemctl daemon-reload

echo "[5/6] Deleting SSL certificates..."
rm -rf /etc/ssl/peninsula

echo ""
echo "=========================================="
echo "FULL INSTALLATION"
echo "=========================================="
echo ""

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$REPO_DIR/scripts/install.sh"

echo ""
echo "=========================================="
echo "REINSTALLATION FULLY COMPLETE"
echo "=========================================="
