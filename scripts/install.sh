#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Veuillez exécuter en root (sudo)."
  exit 1
fi

if ! grep -qi "ubuntu" /etc/os-release; then
  echo "Ubuntu requis."
  exit 1
fi

UBUNTU_VERSION=$(lsb_release -rs | cut -d. -f1)
if [[ "$UBUNTU_VERSION" -lt 20 ]]; then
  echo "Ubuntu 20.04+ requis."
  exit 1
fi

APP_DIR="/opt/peninsula-api"
PANEL_DIR="/var/www/peninsula-panel"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DB_NAME="peninsula"
DB_USER="peninsula"

echo "=========================================="
echo "INSTALLATION DE PENINSULA"
echo "=========================================="
echo ""

# Demander le mot de passe PostgreSQL
echo "Sécurité :"
read -sp "Mot de passe pour l'utilisateur PostgreSQL '$DB_USER' : " DB_PASSWORD
echo ""
read -sp "Confirmez le mot de passe : " DB_PASSWORD_CONFIRM
echo ""

if [[ "$DB_PASSWORD" != "$DB_PASSWORD_CONFIRM" ]]; then
  echo "Erreur : les mots de passe ne correspondent pas."
  exit 1
fi

if [[ ${#DB_PASSWORD} -lt 8 ]]; then
  echo "Erreur : le mot de passe doit faire au moins 8 caractères."
  exit 1
fi

echo "✓ Mot de passe défini"
echo ""

echo "Installation des dépendances..."
apt-get update
apt-get install -y curl git nginx postgresql postgresql-contrib

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

systemctl enable postgresql
systemctl restart postgresql

echo "Attente du démarrage de PostgreSQL..."
sleep 2

# Redémarrer l'instance PostgreSQL spécifique
systemctl restart postgresql@16-main 2>/dev/null || true

for i in {1..60}; do
  if sudo -u postgres pg_isready -q 2>/dev/null; then
    echo "PostgreSQL est prêt."
    break
  fi
  echo "Tentative $i/60..."
  sleep 1
done

mkdir -p /etc/ssl/peninsula
if [[ ! -f /etc/ssl/peninsula/peninsula.crt ]]; then
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/ssl/peninsula/peninsula.key \
    -out /etc/ssl/peninsula/peninsula.crt \
    -subj "/CN=peninsula.local" >/dev/null 2>&1
fi

chmod 644 /etc/ssl/peninsula/peninsula.crt
chmod 600 /etc/ssl/peninsula/peninsula.key
chown -R root:root /etc/ssl/peninsula

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1 || sudo -u postgres psql -c "CREATE DATABASE $DB_NAME;"
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname = '$DB_USER'" | grep -q 1 || sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';"
sudo -u postgres psql -c "ALTER DATABASE $DB_NAME OWNER TO $DB_USER;"

mkdir -p "$APP_DIR"
mkdir -p "$PANEL_DIR"

rsync -a --delete "$REPO_DIR/api/" "$APP_DIR/"
rsync -a --delete "$REPO_DIR/panel/" "$PANEL_DIR/"

cd "$APP_DIR"
cp .env.example .env
sed -i "s|DATABASE_URL=.*|DATABASE_URL=postgres://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME|" .env
sed -i "s|JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$(openssl rand -hex 24)|" .env
sed -i "s|JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$(openssl rand -hex 24)|" .env
sed -i "s|CORS_ORIGIN=.*|CORS_ORIGIN=*|" .env

npm install --omit=dev 2>&1 | grep -v "warn deprecated"
npm audit fix --force 2>/dev/null || true
npm ls --depth=0 2>/dev/null
npm run seed:admin

cp "$REPO_DIR/config/peninsula-api.service" /etc/systemd/system/peninsula-api.service
systemctl daemon-reload
systemctl enable peninsula-api
systemctl restart peninsula-api

cp "$REPO_DIR/config/nginx-peninsula.conf" /etc/nginx/sites-available/peninsula
rm -f /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/peninsula /etc/nginx/sites-enabled/peninsula
nginx -t
systemctl start nginx
systemctl reload nginx

echo "Installation terminée."
echo "Panel web : http://$(hostname -I | awk '{print $1}')/"
