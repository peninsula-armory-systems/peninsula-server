#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# Peninsula — deploy.sh
# Script de déploiement one-shot.
# Usage : ./deploy.sh --start       (première install ou update)
#         ./deploy.sh --stop        (tout arrêter)
#         ./deploy.sh --restart|-r  (relance la stack)
#         ./deploy.sh --dev         (avec phpMyAdmin)
#         ./deploy.sh --reset       (tout supprimer et relancer)
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
ACTION=""
PROFILE=""
for arg in "$@"; do
  case "$arg" in
    --start)          ACTION="start" ;;
    --stop)           ACTION="stop" ;;
    --restart|-r)     ACTION="restart" ;;
    --dev)            PROFILE="--profile dev" ;;
    --reset)          ACTION="reset" ;;
    --help|-h)
      echo "Usage: $0 <command> [options]"
      echo ""
      echo "Commands:"
      echo "  --start          Construire et lancer la stack"
      echo "  --stop           Arrêter la stack"
      echo "  --restart, -r    Redémarrer la stack"
      echo "  --reset          Supprimer volumes + relancer (PERTE DE DONNÉES)"
      echo ""
      echo "Options:"
      echo "  --dev            Inclut phpMyAdmin"
      echo "  --help, -h       Afficher cette aide"
      exit 0
      ;;
    *) err "Option inconnue: $arg"; exit 1 ;;
  esac
done

if [ -z "$ACTION" ]; then
  err "Aucune commande spécifiée"
  echo "Usage: $0 --start | --stop | --restart | --reset [--dev]"
  exit 1
fi

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

# ── Stop ────────────────────────────────────────────────
if [ "$ACTION" = "stop" ]; then
  log "Arrêt de la stack..."
  $COMPOSE --profile dev down
  ok "Stack arrêtée"
  exit 0
fi

# ── Restart ─────────────────────────────────────────────
if [ "$ACTION" = "restart" ]; then
  log "Redémarrage de la stack..."
  $COMPOSE $PROFILE down --remove-orphans 2>/dev/null || true
  $COMPOSE $PROFILE up -d
  ok "Stack redémarrée"
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
  ACTION="start"
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

# ── Wait for API health ─────────────────────────────────
log "Attente du health check API..."
source .env 2>/dev/null || true
for i in $(seq 1 90); do
  if curl -sf http://localhost:${API_PORT:-4875}/health > /dev/null 2>&1; then
    ok "API Peninsula opérationnelle"
    break
  fi
  if [ "$i" -eq 90 ]; then
    err "API n'a pas démarré après 90s"
    $COMPOSE logs --tail 30 api
    exit 1
  fi
  sleep 1
done

# ── Wait for PrestaShop ─────────────────────────────────
log "Attente de PrestaShop (première install ≈ 2-3 min)..."
PS_OK=0
for i in $(seq 1 180); do
  PS_STATUS=$($DOCKER inspect -f '{{.State.Status}}' peninsula-prestashop 2>/dev/null || echo "missing")
  PS_RESTARTS=$($DOCKER inspect -f '{{.RestartCount}}' peninsula-prestashop 2>/dev/null || echo "0")

  # Si PS restart en boucle (>3 restarts), nuke le volume et relancer
  if [ "$PS_RESTARTS" -gt 3 ]; then
    warn "PrestaShop en boucle de restart — nettoyage du volume..."
    $COMPOSE stop prestashop 2>/dev/null || true
    $DOCKER rm -f peninsula-prestashop 2>/dev/null || true
    $DOCKER volume rm peninsula-server_ps_data 2>/dev/null || true
    $COMPOSE $PROFILE up -d prestashop
    log "PrestaShop relancé avec un volume propre, attente..."
    sleep 10
    continue
  fi

  # Vérifier si PS répond
  if curl -sf -o /dev/null -w '%{http_code}' http://localhost:${PS_PORT:-8080}/ 2>/dev/null | grep -qE '^(200|301|302)'; then
    ok "PrestaShop opérationnel"
    PS_OK=1
    break
  fi

  if [ "$((i % 15))" -eq 0 ]; then
    log "PrestaShop: $PS_STATUS (${i}s / 180s)..."
  fi
  sleep 1
done

if [ "$PS_OK" -eq 0 ]; then
  warn "PrestaShop n'a pas répondu après 180s — vérifiez les logs :"
  warn "  $COMPOSE logs --tail 50 prestashop"
fi

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
echo -e "  Arrêter        : ./deploy.sh --stop"
echo -e "  Redémarrer     : ./deploy.sh -r"
echo ""
