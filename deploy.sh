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

# ── Install dépendances manquantes ──────────────────────
install_pkg() {
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y -qq "$@"
  elif command -v pacman &>/dev/null; then
    sudo pacman -S --noconfirm "$@"
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y "$@"
  else
    err "Impossible d'installer $* — gestionnaire de paquets inconnu"
    exit 1
  fi
}

# Docker
if ! command -v docker &>/dev/null; then
  log "Installation de Docker..."
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq docker.io docker-compose
  elif command -v pacman &>/dev/null; then
    sudo pacman -S --noconfirm docker docker-compose
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y docker docker-compose
  else
    err "Impossible d'installer Docker automatiquement"
    err "Installez Docker manuellement : https://docs.docker.com/engine/install/"
    exit 1
  fi
  sudo systemctl enable --now docker
  ok "Docker installé"
fi

# curl
if ! command -v curl &>/dev/null; then
  log "Installation de curl..."
  install_pkg curl
fi

# openssl (pour la génération de mots de passe)
if ! command -v openssl &>/dev/null; then
  log "Installation de openssl..."
  install_pkg openssl
fi

# docker-compose (si docker compose v2 absent)
if ! docker compose version &>/dev/null 2>&1; then
  if ! command -v docker-compose &>/dev/null; then
    log "Installation de docker-compose..."
    install_pkg docker-compose
  fi
fi

ok "Dépendances OK"

# ── Check Docker ────────────────────────────────────────
DOCKER=""
COMPOSE=""

if docker info &>/dev/null 2>&1; then
  DOCKER="docker"
elif sudo docker info &>/dev/null 2>&1; then
  DOCKER="sudo docker"
  warn "Docker nécessite sudo"
else
  err "Docker daemon non accessible (sudo ? groupe docker ?)"
  exit 1
fi

if $DOCKER compose version &>/dev/null 2>&1; then
  COMPOSE="$DOCKER compose"
elif command -v docker-compose &>/dev/null 2>&1; then
  if [ "$DOCKER" = "sudo docker" ]; then
    COMPOSE="sudo docker-compose"
  else
    COMPOSE="docker-compose"
  fi
else
  err "Ni 'docker compose' ni 'docker-compose' n'est disponible"
  exit 1
fi
ok "Docker accessible ($COMPOSE)"

# ── Down ────────────────────────────────────────────────
if [ "$ACTION" = "down" ]; then
  log "Arrêt de la stack..."
  $COMPOSE --profile dev down
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
  $COMPOSE --profile dev down -v
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

  gen_pass() { openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 32; }

  sed -i "s|CHANGE_ME_pg_password|$(gen_pass)|"      .env
  sed -i "s|CHANGE_ME_random_64_chars|$(gen_pass)|"   .env
  sed -i "s|CHANGE_ME_random_64_chars|$(gen_pass)|"   .env
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

# ── Build + Up ──────────────────────────────────────────
log "Arrêt des anciens conteneurs..."
$COMPOSE $PROFILE down --remove-orphans 2>/dev/null || true

log "Construction et lancement de la stack..."
$COMPOSE $PROFILE build
$COMPOSE $PROFILE up -d

# ── Wait for health ─────────────────────────────────────
log "Attente du health check API..."
source .env 2>/dev/null || true
for i in $(seq 1 60); do
  if curl -sf http://localhost:$\{API_PORT:-4875\}/health > /dev/null 2>&1; then
    ok "API Peninsula opérationnelle"
    break
  fi
  if [ "$i" -eq 60 ]; then
    err "API n'a pas démarré après 60s"
    $COMPOSE logs api --tail 30
    exit 1
  fi
  sleep 1
done

# ── Info ────────────────────────────────────────────────
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
echo -e "  Logs           : $COMPOSE logs -f"
echo -e "  Arrêter        : ./deploy.sh --down"
echo ""
