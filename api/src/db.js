import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function initDb() {
  await query("CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\"");
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS audits (
      id SERIAL PRIMARY KEY,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // ── Catégories ────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // ── Inventaire complet (DB Peninsula) ─────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      sku TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      brand TEXT NOT NULL DEFAULT '',
      condition TEXT NOT NULL DEFAULT 'new' CHECK (condition IN ('new', 'used', 'refurbished')),
      price NUMERIC(10,2) NOT NULL DEFAULT 0,
      cost_price NUMERIC(10,2) NOT NULL DEFAULT 0,
      tax_rate NUMERIC(5,2) NOT NULL DEFAULT 20.00,
      weight NUMERIC(8,3) NOT NULL DEFAULT 0,
      images JSONB NOT NULL DEFAULT '[]'::jsonb,
      attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // ── Stock / Inventaire ────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS stock (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL DEFAULT 0,
      location TEXT NOT NULL DEFAULT '',
      low_stock_threshold INTEGER NOT NULL DEFAULT 2,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(product_id, location)
    );
  `);

  // ── Publication vers PrestaShop ───────────────────────
  // Un produit dans "products" = inventaire Peninsula (complet)
  // Un row ici avec published=true = en vente sur PrestaShop
  // (Naturabuy est géré par un module PS séparé, pas par Peninsula)
  await query(`
    CREATE TABLE IF NOT EXISTS product_channels (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('prestashop')),
      published BOOLEAN NOT NULL DEFAULT false,
      external_id TEXT,
      sale_price NUMERIC(10,2),
      last_synced_at TIMESTAMP,
      sync_error TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(product_id, channel)
    );
  `);

  // ── Commandes reçues des canaux ───────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('prestashop', 'direct')),
      external_order_id TEXT,
      reference TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled')),
      total NUMERIC(10,2) NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'EUR',
      customer JSONB NOT NULL DEFAULT '{}'::jsonb,
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // ── Log de synchronisation ────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS sync_log (
      id SERIAL PRIMARY KEY,
      channel TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('push', 'pull')),
      entity TEXT NOT NULL,
      entity_id INTEGER,
      status TEXT NOT NULL CHECK (status IN ('success', 'error')),
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
}
