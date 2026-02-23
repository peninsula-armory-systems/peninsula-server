#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Peninsula Server — Script de mise à jour
# Usage : sudo ./scripts/update.sh [--no-pull] [--restart-only]
#
# Ce script :
#   1. Git pull (récupère les dernières modifs)
#   2. Rsync des fichiers vers /opt/peninsula-api et /var/www/peninsula-panel
#   3. npm install (installe les nouvelles dépendances si besoin)
#   4. Restart du service peninsula-api (les nouvelles tables se créent auto via initDb)
#   5. Reload nginx
#
# Les tables sont créées automatiquement au démarrage (CREATE IF NOT EXISTS)
# donc pas besoin de migration manuelle.
# ═══════════════════════════════════════════════════════════
set -euo pipefail

# ── Couleurs ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[peninsula]${NC} $1"; }
ok()   { echo -e "${GREEN}  ✓${NC} $1"; }
warn() { echo -e "${YELLOW}  ⚠${NC} $1"; }
fail() { echo -e "${RED}  ✗${NC} $1"; exit 1; }

# ── Vérifications ────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  fail "Ce script doit être exécuté en root (sudo)."
fi

APP_DIR="/opt/peninsula-api"
PANEL_DIR="/var/www/peninsula-panel"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NO_PULL=false
RESTART_ONLY=false

for arg in "$@"; do
  case $arg in
    --no-pull)      NO_PULL=true ;;
    --restart-only) RESTART_ONLY=true ;;
    --help|-h)
      echo "Usage: sudo $0 [--no-pull] [--restart-only]"
      echo ""
      echo "Options:"
      echo "  --no-pull       Ne pas faire git pull (utilise le code local)"
      echo "  --restart-only  Juste redémarrer le service sans sync"
      exit 0
      ;;
  esac
done

echo ""
echo -e "${BLUE}══════════════════════════════════════════${NC}"
echo -e "${BLUE}  PENINSULA — Mise à jour${NC}"
echo -e "${BLUE}══════════════════════════════════════════${NC}"
echo ""

# ── Restart only ─────────────────────────────────────────
if [[ "$RESTART_ONLY" == true ]]; then
  log "Redémarrage du service..."
  systemctl restart peninsula-api
  ok "peninsula-api redémarré"
  systemctl reload nginx 2>/dev/null && ok "nginx rechargé" || warn "nginx non actif"
  echo ""
  log "Status :"
  systemctl is-active peninsula-api && ok "peninsula-api est actif" || fail "peninsula-api n'a pas démarré"
  exit 0
fi

# ── 1. Git pull ──────────────────────────────────────────
if [[ "$NO_PULL" == false ]]; then
  log "[1/5] Git pull..."
  cd "$REPO_DIR"
  BEFORE=$(git rev-parse HEAD)
  git pull --ff-only 2>&1 | sed 's/^/       /'
  AFTER=$(git rev-parse HEAD)
  if [[ "$BEFORE" == "$AFTER" ]]; then
    ok "Déjà à jour ($BEFORE)"
  else
    ok "Mis à jour : $(git log --oneline ${BEFORE}..${AFTER} | wc -l) commit(s)"
    git log --oneline "${BEFORE}..${AFTER}" | sed 's/^/       /'
  fi
else
  log "[1/5] Git pull — ignoré (--no-pull)"
fi

# ── 2. Sauvegarde du .env ────────────────────────────────
log "[2/5] Sauvegarde .env..."
if [[ -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/.env" "$APP_DIR/.env.bak"
  ok ".env sauvegardé dans .env.bak"
else
  warn "Pas de .env existant"
fi

# ── 3. Sync des fichiers ────────────────────────────────
log "[3/5] Synchronisation des fichiers..."
rsync -a --delete --exclude='.env' --exclude='.env.bak' --exclude='node_modules' "$REPO_DIR/api/" "$APP_DIR/"
ok "API → $APP_DIR"

if [[ -d "$REPO_DIR/panel" ]]; then
  rsync -a --delete "$REPO_DIR/panel/" "$PANEL_DIR/"
  ok "Panel → $PANEL_DIR"
fi

# Restaurer le .env
if [[ -f "$APP_DIR/.env.bak" ]]; then
  cp "$APP_DIR/.env.bak" "$APP_DIR/.env"
  ok ".env restauré"
fi

# ── 4. npm install ───────────────────────────────────────
log "[4/5] Installation des dépendances..."
cd "$APP_DIR"
npm install --omit=dev --silent 2>&1 | tail -3
ok "Dépendances à jour"

# ── 5. Restart services ─────────────────────────────────
log "[5/5] Redémarrage des services..."
systemctl restart peninsula-api
ok "peninsula-api redémarré"

systemctl reload nginx 2>/dev/null && ok "nginx rechargé" || warn "nginx non trouvé/actif"

# ── Vérification finale ─────────────────────────────────
echo ""
log "Vérification..."
sleep 2

if systemctl is-active --quiet peninsula-api; then
  ok "peninsula-api est actif (PID $(systemctl show -p MainPID peninsula-api --value))"
else
  fail "peninsula-api n'a pas démarré ! Vérifier : journalctl -u peninsula-api -n 30"
fi

# Test health endpoint
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4875/health 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "200" ]]; then
  ok "Health check OK (HTTP 200)"
else
  warn "Health check HTTP $HTTP_CODE — l'API démarre peut-être encore"
fi

VERSION=$(curl -s http://localhost:4875/version 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4 || echo "?")

echo ""
echo -e "${GREEN}══════════════════════════════════════════${NC}"
echo -e "${GREEN}  Mise à jour terminée — v${VERSION}${NC}"
echo -e "${GREEN}══════════════════════════════════════════${NC}"
echo ""
