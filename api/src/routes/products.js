import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { requireAuth } from "../middleware.js";

const router = Router();

// ── Schemas ─────────────────────────────────────────────

const createProductSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  category_id: z.number().int().nullable().default(null),
  brand: z.string().default(""),
  condition: z.enum(["new", "used", "refurbished"]).default("new"),
  price: z.number().min(0),
  cost_price: z.number().min(0).default(0),
  tax_rate: z.number().min(0).max(100).default(20),
  weight: z.number().min(0).default(0),
  images: z.array(z.string()).default([]),
  attributes: z.record(z.any()).default({}),
  // Stock initial (optionnel)
  initial_stock: z.number().int().min(0).default(0),
  stock_location: z.string().default("default"),
});

const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  category_id: z.number().int().nullable().optional(),
  brand: z.string().optional(),
  condition: z.enum(["new", "used", "refurbished"]).optional(),
  price: z.number().min(0).optional(),
  cost_price: z.number().min(0).optional(),
  tax_rate: z.number().min(0).max(100).optional(),
  weight: z.number().min(0).optional(),
  images: z.array(z.string()).optional(),
  attributes: z.record(z.any()).optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  category_id: z.coerce.number().int().optional(),
  search: z.string().optional(),
  condition: z.enum(["new", "used", "refurbished"]).optional(),
  published_on: z.enum(["prestashop", "naturabuy"]).optional(),
});

// ── Helpers ─────────────────────────────────────────────

async function audit(actorUserId, action, details = {}) {
  await query(
    "INSERT INTO audits(actor_user_id, action, details) VALUES ($1, $2, $3)",
    [actorUserId || null, action, details]
  );
}

// ── LIST ────────────────────────────────────────────────

router.get("/", requireAuth, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() });
  }

  const { page, limit, category_id, search, condition, published_on } = parsed.data;
  const offset = (page - 1) * limit;
  const conditions = [];
  const values = [];
  let idx = 1;

  if (category_id) {
    conditions.push(`p.category_id = $${idx++}`);
    values.push(category_id);
  }
  if (search) {
    conditions.push(`(p.name ILIKE $${idx} OR p.sku ILIKE $${idx} OR p.brand ILIKE $${idx})`);
    values.push(`%${search}%`);
    idx++;
  }
  if (condition) {
    conditions.push(`p.condition = $${idx++}`);
    values.push(condition);
  }
  if (published_on) {
    conditions.push(`EXISTS (SELECT 1 FROM product_channels pc WHERE pc.product_id = p.id AND pc.channel = $${idx} AND pc.published = true)`);
    values.push(published_on);
    idx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await query(
    `SELECT COUNT(*) FROM products p ${where}`,
    values
  );
  const total = parseInt(countResult.rows[0].count, 10);

  values.push(limit, offset);
  const result = await query(
    `SELECT p.*,
            c.name AS category_name,
            COALESCE(s.total_stock, 0) AS total_stock,
            COALESCE(ch.channels, '[]'::jsonb) AS channels
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN LATERAL (
       SELECT SUM(quantity) AS total_stock FROM stock WHERE product_id = p.id
     ) s ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
         'channel', pc.channel,
         'published', pc.published,
         'external_id', pc.external_id,
         'sale_price', pc.sale_price,
         'last_synced_at', pc.last_synced_at
       )) AS channels FROM product_channels pc WHERE pc.product_id = p.id
     ) ch ON true
     ${where}
     ORDER BY p.updated_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    values
  );

  return res.json({
    products: result.rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// ── GET ONE ─────────────────────────────────────────────

router.get("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const result = await query(
    `SELECT p.*,
            c.name AS category_name,
            COALESCE(ch.channels, '[]'::jsonb) AS channels
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
         'channel', pc.channel,
         'published', pc.published,
         'external_id', pc.external_id,
         'sale_price', pc.sale_price,
         'last_synced_at', pc.last_synced_at
       )) AS channels FROM product_channels pc WHERE pc.product_id = p.id
     ) ch ON true
     WHERE p.id = $1`,
    [id]
  );

  if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });

  // Stock par emplacement
  const stockResult = await query(
    "SELECT location, quantity, low_stock_threshold, updated_at FROM stock WHERE product_id = $1 ORDER BY location",
    [id]
  );

  return res.json({ product: result.rows[0], stock: stockResult.rows });
});

// ── CREATE ──────────────────────────────────────────────

router.post("/", requireAuth, async (req, res) => {
  const parsed = createProductSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const d = parsed.data;

  try {
    const result = await query(
      `INSERT INTO products(sku, name, description, category_id, brand, condition, price, cost_price, tax_rate, weight, images, attributes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [d.sku, d.name, d.description, d.category_id, d.brand, d.condition, d.price, d.cost_price, d.tax_rate, d.weight, JSON.stringify(d.images), d.attributes]
    );

    const product = result.rows[0];

    // Créer le stock initial
    if (d.initial_stock >= 0) {
      await query(
        "INSERT INTO stock(product_id, quantity, location) VALUES ($1, $2, $3)",
        [product.id, d.initial_stock, d.stock_location]
      );
    }

    await audit(req.user.sub, "product_created", { id: product.id, sku: d.sku, name: d.name });
    return res.status(201).json({ product });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "sku_exists" });
    }
    throw error;
  }
});

// ── UPDATE ──────────────────────────────────────────────

router.put("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const parsed = updateProductSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const fields = parsed.data;
  const updates = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      const dbValue = key === "images" ? JSON.stringify(value) : (key === "attributes" ? value : value);
      updates.push(`${key} = $${idx++}`);
      values.push(dbValue);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: "no_updates" });
  }

  updates.push(`updated_at = NOW()`);
  values.push(id);

  const result = await query(
    `UPDATE products SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );

  if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });

  await audit(req.user.sub, "product_updated", { id, fields: Object.keys(fields) });
  return res.json({ product: result.rows[0] });
});

// ── DELETE ──────────────────────────────────────────────

router.delete("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const result = await query("DELETE FROM products WHERE id = $1 RETURNING id, sku", [id]);
  if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });

  await audit(req.user.sub, "product_deleted", { id, sku: result.rows[0].sku });
  return res.json({ success: true });
});

export default router;
