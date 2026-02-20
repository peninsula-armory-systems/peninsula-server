#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Veuillez exécuter en root (sudo)."
  exit 1
fi

APP_DIR="/opt/peninsula-api"
PANEL_DIR="/var/www/peninsula-panel"
REPO_DIR="$(pwd)"

echo "Mise à jour..."

git -C "$REPO_DIR" pull

rsync -a --delete "$REPO_DIR/api/" "$APP_DIR/"
rsync -a --delete "$REPO_DIR/panel/" "$PANEL_DIR/"

cd "$APP_DIR"
npm install --production
systemctl restart peninsula-api

systemctl reload nginx

echo "Mise à jour terminée."
