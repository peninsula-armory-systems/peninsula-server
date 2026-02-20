#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Veuillez exécuter en root (sudo)."
  exit 1
fi

APP_DIR="/opt/peninsula-api"
PANEL_DIR="/var/www/peninsula-panel"
DB_NAME="peninsula"
DB_USER="peninsula"

echo "=========================================="
echo "RÉINSTALLATION COMPLÈTE DE PENINSULA"
echo "=========================================="
echo ""
echo "⚠️  ATTENTION : Cela va supprimer :"
echo "   - La base de données PostgreSQL"
echo "   - Les fichiers de l'application"
echo "   - Les configurations Nginx et SSL"
echo ""
read -p "Êtes-vous sûr ? (oui/non) : " confirmation
if [[ "$confirmation" != "oui" ]]; then
  echo "Annulé."
  exit 0
fi

echo ""
echo "[1/6] Arrêt des services..."
systemctl stop peninsula-api || true
systemctl stop nginx || true

echo "[2/6] Suppression de la base de données..."
sudo -u postgres psql -c "DROP DATABASE IF EXISTS $DB_NAME;" || true
sudo -u postgres psql -c "DROP USER IF EXISTS $DB_USER;" || true

echo "[3/6] Suppression des fichiers d'application..."
rm -rf "$APP_DIR"
rm -rf "$PANEL_DIR"

echo "[4/6] Suppression des configurations systemd et nginx..."
rm -f /etc/systemd/system/peninsula-api.service
rm -f /etc/nginx/sites-available/peninsula
rm -f /etc/nginx/sites-enabled/peninsula
systemctl daemon-reload

echo "[5/6] Suppression des certificats SSL..."
rm -rf /etc/ssl/peninsula

echo ""
echo "=========================================="
echo "INSTALLATION COMPLÈTE"
echo "=========================================="
echo ""

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$REPO_DIR/scripts/install.sh"

echo ""
echo "=========================================="
echo "RÉINSTALLATION COMPLÈTEMENT TERMINÉE"
echo "=========================================="
