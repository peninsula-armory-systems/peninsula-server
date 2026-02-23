#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# Peninsula — deploy.sh
# Script de déploiement one-shot.
# Usage : ./deploy.sh          (première install ou update)
#         ./deploy.sh --dev    (avec phpMyAdmin)
#         ./deploy.sh --down   (tout arrêter)
#         ./deploy.sh --reset  (tout supprimer et relancer)
# ─────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[peninsula]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1" >&2; }

# ── Parse args ──────────────────────────────────────────
ACTION="up"
PROFILE=""
for arg in "$@"; do
  case "$arg" in
    --dev)   PROFILE="--profile dev" ;;
    --down)  ACTION="down" ;;
    --reset) ACTION="reset" ;;
    --help|-h)
      echo "Usage: $0 [--dev] [--down] [--reset]"
      echo "  --dev    Inclut phpMyAdmin"
      echo "  --down   Arrête la stack"
      echo "  --reset  Supprime volumes + relance (PERTE DE DONNÉES)"
      exit 0
      ;;
    *) err "Option inconnue: $arg"; exit 1 ;;
  esac
done

# ── Down ────────────────────────────────────────────────
if [ "$ACTION" = "down" ]; then
  log "Arrêt de la stack..."
  docker compose --profile dev down
  ok "Stack arrêtée"
  exit 0
fi

# ── Reset ───────────────────────────────────────────────
if [ "$ACTION" = "reset" ]; then
  warn "⚠  CECI VA SUPPRIMER TOUTES LES DONNÉES (volumes Docker)"
  read -r -p "Confirmer ? (oui/non) " confirm
  if [ "$confirm" != "oui" ]; then
    log "Annulé."
    exit 0
  fi
  log "Suppression des volumes..."
  docker compose --profile dev down -v
  ok "Volumes supprimés"
fi

# ── Check .env ──────────────────────────────────────────
if [ ! -f .env ]; then
  log ".env absent — génération depuis .env.example..."

  if [ ! -f .env.example ]; then
    err ".env.example introuvable"
    exit 1
  fi

  cp .env.example .env

  # Générer des mots de passe aléatoires
  gen_pass() { openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 32; }

  sed -i "s|CHANGE_ME_pg_password|$(gen_pass)|"      .env
  sed -i "s|CHANGE_ME_random_64_chars|$(gen_pass)|"   .env  # access secret
  # Le second CHANGE_ME_random_64_chars
  sed -i "s|CHANGE_ME_random_64_chars|$(gen_pass)|"   .env  # refresh secret
  sed -i "s|CHANGE_ME_admin_password|$(gen_pass)|"    .env
  sed -i "s|CHANGE_ME_mysql_root|$(gen_pass)|"        .env
  sed -i "s|CHANGE_ME_mysql_password|$(gen_pass)|"    .env
  sed -i "s|CHANGE_ME_ps_admin|Peninsula$(gen_pass | head -c 8)|" .env

  ok ".env généré avec des mots de passe aléatoires"
  warn "→ Vérifiez .env avant de continuer, surtout ADMIN_USER / ADMIN_PASS"
  warn "→ Relancez ./deploy.sh quand c'est prêt"
  exit 0
fi

log "Fichier .env trouvé ✓"

# ── Check Docker ────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  err "Docker n'est pas installé"
  exit 1
fi

if ! docker info &>/dev/null; then
  err "Docker daemon non accessible (sudo ? groupe docker ?)"
  exit 1
fi

# ── Build + Up ──────────────────────────────────────────
log "Construction et lancement de la stack..."
docker compose $PROFILE build --pull
docker compose $PROFILE up -d

# ── Wait for health ─────────────────────────────────────
log "Attente du health check API..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:${API_PORT:-4875}/health > /dev/null 2>&1; then
    ok "API Peninsula opérationnelle"
    break
  fi
  if [ "$i" -eq 30 ]; then
    err "API n'a pas démarré après 30s"
    docker compose logs api --tail 20
    exit 1
  fi
  sleep 1
done

# ── Info ────────────────────────────────────────────────
source .env 2>/dev/null || true

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Peninsula Stack déployée avec succès !${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  API Peninsula  : ${CYAN}http://localhost:${API_PORT:-4875}${NC}"
echo -e "  Health check   : ${CYAN}http://localhost:${API_PORT:-4875}/health${NC}"
echo -e "  PrestaShop     : ${CYAN}http://${PS_DOMAIN:-localhost:8080}${NC}"
echo -e "  PS Admin       : ${CYAN}http://${PS_DOMAIN:-localhost:8080}/${PS_FOLDER_ADMIN:-admin-peninsula}${NC}"

if echo "$PROFILE" | grep -q dev; then
  echo -e "  phpMyAdmin     : ${CYAN}http://localhost:${PMA_PORT:-8081}${NC}"
fi

echo ""
echo -e "  Admin API      : ${YELLOW}${ADMIN_USER:-admin}${NC} / (voir .env ADMIN_PASS)"
echo -e "  Admin PS       : ${YELLOW}${PS_ADMIN_MAIL:-admin@peninsula.local}${NC} / (voir .env PS_ADMIN_PASSWD)"
echo ""
echo -e "  Logs           : docker compose logs -f"
echo -e "  Arrêter        : ./deploy.sh --down"
echo ""
