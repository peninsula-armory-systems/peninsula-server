# Peninsula Server

API centrale pour le système Peninsula Armory Systems.

> **Peninsula DB (PSQL) = source de vérité unique** — les produits sont ajoutés via PrestaShop (web), synchronisés vers la base PSQL, et exploités par le client desktop (boutique IRL).

```
PrestaShop (web)                  Peninsula DB (PSQL)              Desktop Client (IRL)
  ajout produits ──── push ────→    source de vérité     ←──── lecture produits
  commandes web ──── push ────→    stock, clients              modif quantités
                                   armes, paiements            vente comptoir
                                   registre armes              rentrées stock
```

## Stack

| Composant | Techno |
|---|---|
| API | Node.js / Express 4 (ESM) |
| Base de données | PostgreSQL |
| Auth | JWT (access + refresh tokens) |
| Validation | Zod |
| Desktop Client | C++ / Qt6 |
| Web Store | PrestaShop 8 |
| Proxy | Nginx + SSL self-signed |

---

## Installation

```bash
# Sur la VM (Ubuntu 20.04+)
git clone <repo> peninsula-server
cd peninsula-server
sudo ./scripts/install.sh
```

Le script installe tout : PostgreSQL, Node.js 20, Nginx, SSL, crée la DB et l'admin.

## Mise à jour

```bash
# Depuis le répertoire du projet sur la VM
sudo ./scripts/update.sh
```

Le script :
1. `git pull` (récupère les derniers commits)
2. Sauvegarde le `.env` existant
3. `rsync` les fichiers vers `/opt/peninsula-api`
4. `npm install` (nouvelles dépendances)
5. Redémarre le service — **les nouvelles tables se créent automatiquement** au démarrage (`CREATE TABLE IF NOT EXISTS`)

**Options :**
```bash
sudo ./scripts/update.sh --no-pull       # Utilise le code local sans git pull
sudo ./scripts/update.sh --restart-only  # Juste redémarrer le service
```

---

## Architecture de la base de données

### Tables principales

#### `users` — Utilisateurs du système
| Colonne | Type | Description |
|---|---|---|
| id | SERIAL | Clé primaire |
| username | TEXT UNIQUE | Login |
| password_hash | TEXT | Bcrypt |
| role | TEXT | `admin` ou `user` |

#### `products` — Inventaire complet
Tous les produits, qu'ils soient en vente web ou pas.

| Colonne | Type | Description |
|---|---|---|
| id | SERIAL | Clé primaire |
| sku | TEXT UNIQUE | Référence unique (= reference PS) |
| name | TEXT | Nom du produit |
| description | TEXT | Description |
| category_id | INTEGER FK | Catégorie |
| brand | TEXT | Marque |
| condition | TEXT | `new`, `used`, `refurbished` |
| price | NUMERIC | Prix de vente TTC |
| cost_price | NUMERIC | Prix d'achat |
| tax_rate | NUMERIC | Taux TVA (défaut 20%) |
| weight | NUMERIC | Poids en kg |
| images | JSONB | URLs des images `["url1", "url2"]` |
| attributes | JSONB | Attributs libres `{"calibre": "9mm"}` |

#### `stock` — Stock par emplacement
Un produit peut avoir du stock à plusieurs endroits : `web`, `boutique`, `réserve`, etc.

| Colonne | Type | Description |
|---|---|---|
| product_id | INTEGER FK | Produit |
| quantity | INTEGER | Quantité |
| location | TEXT | Emplacement (`default`, `web`, `boutique`, `reserve`) |
| low_stock_threshold | INTEGER | Seuil d'alerte stock bas |

**Contrainte :** `UNIQUE(product_id, location)`

#### `customers` — Clients
| Colonne | Type | Description |
|---|---|---|
| id | SERIAL | Clé primaire |
| first_name, last_name | TEXT | Nom |
| email, phone | TEXT | Contact |
| address | JSONB | `{"street", "city", "zip", "country"}` |
| type | TEXT | `individual` ou `professional` |
| license_number | TEXT | N° permis (obligatoire pour cat. A/A1/B) |
| license_expiry | DATE | Expiration du permis |
| id_document | TEXT | Pièce d'identité |

#### `orders` — Commandes
Sources : `prestashop` (web) ou `direct` (comptoir IRL).

| Colonne | Type | Description |
|---|---|---|
| source | TEXT | `prestashop` ou `direct` |
| customer_id | INTEGER FK | Client Peninsula |
| external_order_id | TEXT | ID commande PS |
| status | TEXT | `pending` → `confirmed` → `shipped` → `delivered` / `completed` / `cancelled` |
| total | NUMERIC | Total TTC |
| items | JSONB | Détail des lignes |

#### `payments` — Paiements
| Colonne | Type | Description |
|---|---|---|
| order_id | INTEGER FK | Commande |
| method | TEXT | `cash`, `card`, `transfer`, `check` |
| amount | NUMERIC | Montant |
| status | TEXT | `pending`, `completed`, `refunded`, `failed` |

#### `firearm_records` — Registre d'armes (livre de police)
Chaque arme individuelle avec numéro de série.

| Colonne | Type | Description |
|---|---|---|
| serial_number | TEXT UNIQUE | N° de série |
| manufacturer | TEXT | Fabricant |
| model | TEXT | Modèle |
| caliber | TEXT | Calibre |
| category | TEXT | Catégorie légale : `A`, `A1`, `B`, `C`, `D` |
| status | TEXT | `in_stock`, `reserved`, `sold`, `transferred`, `returned_supplier`, `destroyed` |
| customer_id | INTEGER FK | Acheteur (quand vendu) |
| sale_date | DATE | Date de vente |
| supplier | TEXT | Fournisseur d'origine |
| purchase_price | NUMERIC | Prix d'achat |
| stock_entry_id | INTEGER FK | Rentrée de stock associée |

#### `stock_entries` — Rentrées fournisseur
| Colonne | Type | Description |
|---|---|---|
| supplier | TEXT | Nom du fournisseur |
| reference | TEXT | N° de commande fournisseur |
| status | TEXT | `pending`, `partial`, `received` |
| items | JSONB | Liste des articles avec `serial_numbers[]` |
| received_by | INTEGER FK | Utilisateur qui a réceptionné |

#### `product_channels` — Lien PS ↔ Peninsula
| Colonne | Type | Description |
|---|---|---|
| product_id | INTEGER FK | Produit Peninsula |
| channel | TEXT | `prestashop` |
| external_id | TEXT | ID produit dans PS |
| published | BOOLEAN | En vente sur PS |

#### Autres tables
- `categories` — Catégories hiérarchiques (parent_id)
- `audits` — Log de toutes les actions (qui a fait quoi)
- `sync_log` — Log de synchronisation PS ↔ Peninsula
- `refresh_tokens` — Tokens JWT de refresh

---

## API Reference

### Authentification

Toutes les routes `/v1/*` (sauf webhooks) nécessitent un header `Authorization: Bearer <accessToken>`.

```
POST /v1/auth/login         { username, password }  → { accessToken, refreshToken }
POST /v1/auth/refresh       { refreshToken }        → { accessToken }
```

L'access token expire en 15min, le refresh token en 7 jours.

### Produits — `/v1/products`

| Méthode | Endpoint | Description |
|---|---|---|
| GET | `/v1/products` | Lister (paginé, filtrable par search, category_id, condition) |
| GET | `/v1/products/:id` | Détail + stock par emplacement |
| POST | `/v1/products` | Créer (avec stock initial optionnel) |
| PUT | `/v1/products/:id` | Modifier |
| DELETE | `/v1/products/:id` | Supprimer |

**Exemple — lister avec filtre :**
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://192.168.1.65:4875/v1/products?search=glock&condition=new&page=1&limit=20"
```

### Stock — `/v1/stock`

| Méthode | Endpoint | Description |
|---|---|---|
| GET | `/v1/stock/:productId` | Stock par emplacement + alertes |
| PUT | `/v1/stock/:productId` | Modifier (mode `set` ou `adjust`) |
| PUT | `/v1/stock/:productId/threshold` | Définir seuil alerte stock bas |
| GET | `/v1/stock/alerts/low` | Tous les produits en stock bas |

**Exemple — ajuster stock (+5 en boutique) :**
```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"quantity": 5, "location": "boutique", "mode": "adjust"}' \
  http://192.168.1.65:4875/v1/stock/42
```

### Clients — `/v1/customers`

| Méthode | Endpoint | Description |
|---|---|---|
| GET | `/v1/customers` | Lister (search, type) |
| GET | `/v1/customers/:id` | Détail + commandes + armes achetées |
| POST | `/v1/customers` | Créer |
| PUT | `/v1/customers/:id` | Modifier |
| DELETE | `/v1/customers/:id` | Supprimer |

**Exemple — créer un client :**
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "first_name": "Jean",
    "last_name": "Dupont",
    "phone": "0612345678",
    "type": "individual",
    "license_number": "SIA-2024-12345",
    "license_expiry": "2027-06-15"
  }' \
  http://192.168.1.65:4875/v1/customers
```

### Commandes — `/v1/orders`

| Méthode | Endpoint | Description |
|---|---|---|
| GET | `/v1/orders` | Lister (filtrable par source, status, customer_id) |
| GET | `/v1/orders/:id` | Détail + paiements |
| POST | `/v1/orders/direct` | **Vente comptoir IRL** |
| PUT | `/v1/orders/:id/status` | Changer le statut |

**Exemple — vente comptoir avec paiement immédiat :**
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": 1,
    "items": [
      {"name": "Glock 17 Gen5", "sku": "GLK-17-G5", "quantity": 1, "unit_price": 650, "firearm_id": 7}
    ],
    "payment_method": "card"
  }' \
  http://192.168.1.65:4875/v1/orders/direct
```

Ce endpoint :
- Crée la commande avec ref auto `PEN-202602-XXXXX`
- Décrémente le stock automatiquement
- Marque l'arme (firearm_id) comme `sold` et l'associe au client
- Enregistre le paiement CB
- Passe la commande en `completed`

### Paiements — `/v1/payments`

| Méthode | Endpoint | Description |
|---|---|---|
| GET | `/v1/payments/order/:orderId` | Paiements d'une commande (total payé, restant) |
| POST | `/v1/payments` | Ajouter un paiement |
| POST | `/v1/payments/:id/refund` | Rembourser un paiement |

### Registre d'armes — `/v1/firearms`

| Méthode | Endpoint | Description |
|---|---|---|
| GET | `/v1/firearms` | Lister (filtrable par status, category, search, customer_id) |
| GET | `/v1/firearms/:id` | Détail complet |
| GET | `/v1/firearms/serial/:serial` | **Recherche par n° de série** |
| POST | `/v1/firearms` | Enregistrer une arme |
| PUT | `/v1/firearms/:id` | Modifier |
| POST | `/v1/firearms/:id/sell` | **Vendre à un client** |

**Exemple — enregistrer une arme :**
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "serial_number": "ABC12345",
    "manufacturer": "Glock",
    "model": "17 Gen5",
    "caliber": "9x19mm",
    "category": "B",
    "supplier": "Rivolier",
    "purchase_price": 420
  }' \
  http://192.168.1.65:4875/v1/firearms
```

**Exemple — vendre une arme (vérifie le permis) :**
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"customer_id": 1}' \
  http://192.168.1.65:4875/v1/firearms/7/sell
```

> ⚠️ Pour les armes de catégorie A, A1 et B, le client **doit** avoir un `license_number` enregistré, sinon l'API refuse la vente avec `customer_license_required`.

### Rentrées stock — `/v1/stock-entries`

| Méthode | Endpoint | Description |
|---|---|---|
| GET | `/v1/stock-entries` | Lister (filtrable par status) |
| GET | `/v1/stock-entries/:id` | Détail |
| POST | `/v1/stock-entries` | Créer une commande fournisseur |
| POST | `/v1/stock-entries/:id/receive` | **Réceptionner** (partiel ou total) |

**Exemple — réceptionner avec numéros de série :**
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "supplier": "Rivolier",
    "reference": "CMD-2026-0042",
    "items": [
      {"sku": "GLK-17-G5", "name": "Glock 17 Gen5", "quantity": 3, "unit_cost": 420, "serial_numbers": ["SN001", "SN002", "SN003"]}
    ]
  }' \
  http://192.168.1.65:4875/v1/stock-entries
```

Puis réceptionner :
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "received_items": [{"index": 0, "quantity_received": 3, "location": "boutique"}]
  }' \
  http://192.168.1.65:4875/v1/stock-entries/1/receive
```

Cela :
- Incrémente le stock (+3 en boutique)
- Crée automatiquement 3 entrées dans `firearm_records` avec les numéros de série
- Passe le statut à `received`

### Catégories — `/v1/categories`

CRUD standard. Slug unique, hiérarchie parent_id.

### Canaux — `/v1/channels`

Gère le lien PrestaShop ↔ Peninsula. Utilisé par le module PS.

### Webhooks PrestaShop — `/v1/webhook/prestashop`

Endpoints appelés par le module PS (pas d'auth JWT, appelés par les hooks PS) :

| Endpoint | Quand |
|---|---|
| `POST /v1/webhook/prestashop/product` | Produit créé/modifié/supprimé dans PS |
| `POST /v1/webhook/prestashop/order` | Commande validée sur PS |
| `POST /v1/webhook/prestashop/stock` | Stock modifié dans PS (log uniquement) |

### Admin — `/v1/admin`

```
GET  /v1/admin/users/list     Lister les utilisateurs (admin only)
POST /v1/admin/users/create   Créer un utilisateur
POST /v1/admin/users/update   Modifier
POST /v1/admin/users/delete   Supprimer
```

---

## Flux métier

### 1. Ajout produit (web)
```
Ajout dans PrestaShop BO
  → Hook actionObjectProductAddAfter
  → Module PeninsulaConnector POST /v1/webhook/prestashop/product
  → Produit créé/mis à jour dans Peninsula DB
  → Visible dans le Desktop Client
```

### 2. Vente comptoir (IRL)
```
Client se présente en boutique
  → Employé cherche le produit sur Desktop Client (GET /v1/products?search=...)
  → Crée/sélectionne le client (POST /v1/customers)
  → Crée la commande directe (POST /v1/orders/direct)
    → Stock décrémenté automatiquement
    → Arme marquée "sold" (si firearm_id)
    → Paiement enregistré
```

### 3. Commande web
```
Client achète sur PrestaShop
  → Hook actionValidateOrder
  → POST /v1/webhook/prestashop/order
  → Commande créée dans Peninsula (source: "prestashop")
  → Stock web décrémenté
  → Employé voit la commande dans le Desktop Client
  → Change le statut : confirmed → shipped → delivered
```

### 4. Rentrée fournisseur
```
Commande passée chez le fournisseur
  → POST /v1/stock-entries (créer la rentrée)
  → Colis arrive → POST /v1/stock-entries/:id/receive
    → Stock incrémenté
    → Armes enregistrées avec numéros de série
    → Statut "received"
```

### 5. Traçabilité arme
```
GET /v1/firearms/serial/ABC12345
  → Historique complet : fournisseur, date entrée, acheteur, date vente
```

---

## Fichiers

```
peninsula-server/
├── api/
│   ├── package.json
│   ├── src/
│   │   ├── index.js          ← Entry point + routes auth/admin
│   │   ├── db.js             ← Pool PG + initDb (CREATE TABLE IF NOT EXISTS)
│   │   ├── auth.js           ← JWT sign/verify
│   │   ├── middleware.js      ← requireAuth, requireAdmin
│   │   └── routes/
│   │       ├── products.js    ← CRUD produits
│   │       ├── stock.js       ← Gestion stock multi-emplacement
│   │       ├── customers.js   ← CRUD clients
│   │       ├── orders.js      ← Commandes web + comptoir
│   │       ├── payments.js    ← Paiements + remboursements
│   │       ├── firearms.js    ← Registre d'armes / livre de police
│   │       ├── stock-entries.js ← Rentrées fournisseur
│   │       ├── categories.js  ← Catégories produits
│   │       ├── channels.js    ← Lien PS ↔ Peninsula
│   │       └── webhooks.js    ← Réception données PS
│   └── scripts/
│       └── create_admin.js    ← Seed admin initial
├── config/
│   ├── peninsula-api.service  ← Systemd unit
│   └── nginx-peninsula.conf  ← Config Nginx
├── panel/                     ← Panel web admin
├── scripts/
│   ├── install.sh             ← Installation complète
│   ├── update.sh              ← Mise à jour (git pull + restart)
│   └── reinstall.sh           ← Réinstallation totale (efface tout)
└── README.md
```

---

## Déploiement

La VM tourne sur `192.168.1.65` (vbox-server). L'API écoute sur le port `4875`.

```bash
# Depuis la machine de dev
cd peninsula-server
git add -A && git commit -m "feat: nouvelle fonctionnalité"
git push

# Sur la VM
ssh vbox-server
cd /chemin/vers/peninsula-server
sudo ./scripts/update.sh
```

Les nouvelles tables sont créées automatiquement au redémarrage grâce à `initDb()` qui utilise `CREATE TABLE IF NOT EXISTS`. **Pas besoin de migrations SQL manuelles.**

---

## Branches

`main` = production (stable)

`dev` = développement

## License

This project is released under the Nivmizz7 personal license based on GPLv3.

See [LICENSE](LICENSE).
