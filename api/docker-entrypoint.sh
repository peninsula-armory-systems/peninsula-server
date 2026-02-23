#!/bin/sh
set -e

echo "⏳ Waiting for PostgreSQL..."
until node --input-type=module -e "
  import pg from 'pg';
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try { await pool.query('SELECT 1'); pool.end(); } catch { pool.end(); process.exit(1); }
" 2>/dev/null; do
  sleep 1
done
echo "✓ PostgreSQL ready"

# Auto-seed admin user (create_admin.js is idempotent)
if [ -n "$ADMIN_USER" ] && [ -n "$ADMIN_PASS" ]; then
  echo "⏳ Seeding admin user..."
  node scripts/create_admin.js "$ADMIN_USER" "$ADMIN_PASS" 2>&1 || true
fi

echo "🚀 Starting Peninsula API..."
exec node src/index.js
