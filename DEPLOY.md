# 🚀 Peninsula — Déploiement

Déploiement complet de la stack Peninsula (API + PostgreSQL + PrestaShop + MySQL) en **une seule commande**.

---

## Prérequis

| Outil | Version min. |
|-------|-------------|
| Docker | 24+ |
| Docker Compose | v2 (intégré dans Docker Desktop / `docker compose`) |
| Git | 2.x |
| curl | (pour le health check dans `deploy.sh`) |
| openssl | (pour la génération de mots de passe) |

```bash
# Vérifier
docker --version
docker compose version
```

---

## Déploiement rapide (première fois)

```bash
# 1. Cloner le repo
git clone git@github.com:peninsula-armory-systems/peninsula-server.git
cd peninsula-server

# 2. Lancer le déploiement
./deploy.sh
```

Au premier lancement, `deploy.sh` :
1. Détecte l'absence de `.env`
2. Copie `.env.example` → `.env`
3. Génère des **mots de passe aléatoires** pour tous les services
4. S'arrête pour que vous puissiez vérifier `.env`

```bash
# 3. Vérifier / ajuster .env (surtout ADMIN_USER, ADMIN_PASS, PS_DOMAIN)
nano .env

# 4. Relancer
./deploy.sh
```

C'est tout. La stack démarre et affiche les URLs.

---

## Architecture Docker

```
┌─────────────────────────────────────────────────────────┐
│                    peninsula-net                        │
│                                                         │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │ postgres │◄───│ peninsula-api│◄───│  prestashop   │  │
│  │ :5432    │    │ :4875        │    │  :80          │  │
│  └──────────┘    └──────────────┘    └───────┬───────┘  │
│                                              │          │
│                                      ┌───────┴───────┐  │
│                                      │   ps-mysql    │  │
│                                      │   :3306       │  │
│                                      └───────────────┘  │
└─────────────────────────────────────────────────────────┘

Ports exposés (hôte) :
  • API      → localhost:4875
  • PS       → localhost:8080
  • PMA      → localhost:8081  (profil dev uniquement)
```

---

## Commandes

| Commande | Description |
|----------|-------------|
| `./deploy.sh` | Build + lancement |
| `./deploy.sh --dev` | Idem + phpMyAdmin |
| `./deploy.sh --down` | Arrêter la stack |
| `./deploy.sh --reset` | **Supprimer toutes les données** + relancer |
| `docker compose logs -f` | Suivre les logs |
| `docker compose logs api` | Logs API seulement |
| `docker compose ps` | État des containers |
| `docker compose exec api sh` | Shell dans le container API |

---

## Configuration (.env)

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PG_USER` | `peninsula` | User PostgreSQL |
| `PG_PASSWORD` | *(généré)* | Mot de passe PostgreSQL |
| `PG_DB` | `peninsula` | Nom de la base |
| `PG_PORT` | `5432` | Port PostgreSQL exposé |
| `JWT_ACCESS_SECRET` | *(généré)* | Secret JWT access token |
| `JWT_REFRESH_SECRET` | *(généré)* | Secret JWT refresh token |
| `JWT_ACCESS_TTL` | `15m` | Durée access token |
| `JWT_REFRESH_TTL` | `7d` | Durée refresh token |
| `API_PORT` | `4875` | Port API exposé |
| `ADMIN_USER` | `admin` | Username admin auto-créé |
| `ADMIN_PASS` | *(généré)* | Password admin auto-créé |
| `MYSQL_ROOT_PASSWORD` | *(généré)* | Root MySQL |
| `MYSQL_PASSWORD` | *(généré)* | User MySQL pour PS |
| `PS_DOMAIN` | `localhost:8080` | Domaine PrestaShop |
| `PS_PORT` | `8080` | Port PS exposé |
| `PS_ADMIN_MAIL` | `admin@peninsula.local` | Email admin PS |
| `PS_ADMIN_PASSWD` | *(généré)* | Password admin PS |
| `PS_FOLDER_ADMIN` | `admin-peninsula` | Dossier admin PS |

---

## Mise à jour

```bash
cd peninsula-server
git pull
./deploy.sh
```

`deploy.sh` rebuild l'image API et relance les containers. Les données (volumes Docker) sont préservées.

---

## Module PrestaShop

Le module `peninsulaconnector` est monté automatiquement dans le container PS via un volume Docker :

```
./prestashop/peninsulaconnector/ → /var/www/html/modules/peninsulaconnector/
```

### Première installation du module

1. Aller dans le back-office PS : `http://localhost:8080/admin-peninsula`
2. **Modules** → **Module Manager** → chercher "Peninsula"
3. **Installer** le module
4. **Configurer** :
   - URL API : `http://peninsula-api:4875` *(déjà par défaut)*
   - Cliquer **Sauvegarder** → doit afficher "✓ Connexion API réussie"
5. Cliquer **Pousser tous les produits vers Peninsula** pour la synchro initiale

### Flux de synchronisation

```
PrestaShop (web)  ──webhook──►  API Peninsula  ──►  PostgreSQL
                                                        ▲
                                              Desktop Client (lecture)
```

Les produits sont **créés dans PrestaShop** et automatiquement poussés vers PostgreSQL via les hooks PS8 Symfony.

---

## Vérification

```bash
# API health
curl http://localhost:4875/health
# → {"status":"ok"}

# Login
curl -X POST http://localhost:4875/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"VOTRE_ADMIN_PASS"}'
# → {"accessToken":"...","refreshToken":"..."}

# Lister les produits
curl http://localhost:4875/v1/products?limit=5 \
  -H "Authorization: Bearer VOTRE_TOKEN"
```

---

## Backup / Restore

```bash
# Backup PostgreSQL
docker compose exec postgres pg_dump -U peninsula peninsula > backup_$(date +%Y%m%d).sql

# Restore
docker compose exec -T postgres psql -U peninsula peninsula < backup_20260223.sql

# Backup MySQL (PrestaShop)
docker compose exec ps-mysql mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" prestashop > ps_backup.sql
```

---

## Dépannage

### L'API ne démarre pas
```bash
docker compose logs api --tail 50
```

### PrestaShop ne se connecte pas à l'API
Dans la config du module, l'URL doit être `http://peninsula-api:4875` (nom du service Docker, pas localhost).

### Le module PS ne sync pas les produits
1. Vérifier les logs PS : Back-office → Paramètres Avancés → Logs
2. Vérifier la connectivité : `docker compose exec prestashop curl -s http://peninsula-api:4875/health`
3. Forcer une synchro complète depuis la page du module

### Reset complet
```bash
./deploy.sh --reset
# ⚠ Supprime TOUTES les données (PostgreSQL + MySQL + PS files)
```
