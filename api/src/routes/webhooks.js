import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";

const router = Router();

// ── Schemas ─────────────────────────────────────────────

const productWebhookSchema = z.object({
  action: z.enum(["create", "update", "delete"]),
  ps_product_id: z.number().int(),
  reference: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  price: z.number().min(0),
  wholesale_price: z.number().min(0).default(0),
  weight: z.number().min(0).default(0),
  quantity: z.number().int().default(0),
  condition: z.enum(["new", "used", "refurbished"]).default("new"),
  tax_rate: z.number().min(0).default(20),
  category_name: z.string().nullable().optional(),
  images: z.array(z.string()).default([]),
  active: z.boolean().default(true),
});

const orderWebhookSchema = z.object({
  ps_order_id: z.number().int(),
  reference: z.string().optional(),
  total: z.number().min(0),
  currency: z.string().default("EUR"),
  customer: z.record(z.any()).default({}),
  items: z.array(z.object({
    ps_product_id: z.number().int().optional(),
    name: z.string(),
    quantity: z.number().int().min(1),
    unit_price: z.number().min(0),
    reference: z.string().optional(),
  })),
  created_at: z.string().optional(),
});

const stockWebhookSchema = z.object({
  ps_product_id: z.number().int(),
  reference: z.string(),
  quantity: z.number().int(),
});

// ── Helpers ─────────────────────────────────────────────

async function audit(action, details = {}) {
  await query(
    "INSERT INTO audits(actor_user_id, action, details) VALUES (NULL, $1, $2)",
    [action, details]
  );
}

async function findOrCreateCategory(name) {
  if (!name) return null;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const existing = await query("SELECT id FROM categories WHERE slug = $1", [slug]);
  if (existing.rowCount > 0) return existing.rows[0].id;

  const result = await query(
    "INSERT INTO categories(name, slug) VALUES ($1, $2) ON CONFLICT(slug) DO UPDATE SET name = $1 RETURNING id",
    [name, slug]
  );
  return result.rows[0].id;
}

// ── Webhook : produit créé/modifié/supprimé depuis PS ───
// C'est le flux PRINCIPAL : PS est l'endroit où on ajoute les produits

router.post("/product", async (req, res) => {
  const parsed = productWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const d = parsed.data;

  try {
    if (d.action === "delete") {
      // Supprimer le produit de Peninsula s'il existe
      const deleted = await query("DELETE FROM products WHERE sku = $1 RETURNING id, sku", [d.reference]);
      if (deleted.rowCount > 0) {
        await audit("webhook_product_deleted", { sku: d.reference, ps_id: d.ps_product_id });
        await query(
          "INSERT INTO sync_log(channel, direction, entity, entity_id, status, details) VALUES ('prestashop', 'pull', 'product', $1, 'success', $2)",
          [deleted.rows[0].id, { action: "delete", ps_id: d.ps_product_id }]
        );
      }
      return res.json({ success: true, action: "deleted" });
    }

    // Create ou Update
    const categoryId = await findOrCreateCategory(d.category_name);

    const result = await query(
      `INSERT INTO products(sku, name, description, category_id, condition, price, cost_price, tax_rate, weight, images, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT(sku)
       DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         category_id = EXCLUDED.category_id,
         condition = EXCLUDED.condition,
         price = EXCLUDED.price,
         cost_price = EXCLUDED.cost_price,
         tax_rate = EXCLUDED.tax_rate,
         weight = EXCLUDED.weight,
         images = EXCLUDED.images,
         updated_at = NOW()
       RETURNING *`,
      [d.reference, d.name, d.description, categoryId, d.condition, d.price, d.wholesale_price, d.tax_rate, d.weight, JSON.stringify(d.images)]
    );

    const product = result.rows[0];

    // Mettre à jour le stock web (emplacement "web")
    await query(
      `INSERT INTO stock(product_id, quantity, location, updated_at)
       VALUES ($1, $2, 'web', NOW())
       ON CONFLICT(product_id, location)
       DO UPDATE SET quantity = $2, updated_at = NOW()`,
      [product.id, d.quantity]
    );

    // Tracker le lien PS ↔ Peninsula
    await query(
      `INSERT INTO product_channels(product_id, channel, published, external_id, last_synced_at, updated_at)
       VALUES ($1, 'prestashop', $2, $3, NOW(), NOW())
       ON CONFLICT(product_id, channel)
       DO UPDATE SET published = $2, external_id = $3, last_synced_at = NOW(), updated_at = NOW()`,
      [product.id, d.active, d.ps_product_id.toString()]
    );

    const action = d.action === "create" ? "created" : "updated";
    await audit(`webhook_product_${action}`, { sku: d.reference, product_id: product.id, ps_id: d.ps_product_id });
    await query(
      "INSERT INTO sync_log(channel, direction, entity, entity_id, status, details) VALUES ('prestashop', 'pull', 'product', $1, 'success', $2)",
      [product.id, { action, ps_id: d.ps_product_id }]
    );

    return res.status(d.action === "create" ? 201 : 200).json({ success: true, action, product });

  } catch (error) {
    await query(
      "INSERT INTO sync_log(channel, direction, entity, entity_id, status, details) VALUES ('prestashop', 'pull', 'product', NULL, 'error', $1)",
      [{ error: error.message, sku: d.reference }]
    );
    return res.status(500).json({ error: "sync_failed", message: error.message });
  }
});

// ── Webhook : commande PS → Peninsula ───────────────────

router.post("/order", async (req, res) => {
  const parsed = orderWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const d = parsed.data;

  // Vérifier que la commande n'existe pas déjà
  const existing = await query(
    "SELECT id FROM orders WHERE source = 'prestashop' AND external_order_id = $1",
    [d.ps_order_id.toString()]
  );
  if (existing.rowCount > 0) {
    return res.json({ success: true, action: "already_exists", order_id: existing.rows[0].id });
  }

  const result = await query(
    `INSERT INTO orders(source, external_order_id, reference, status, total, currency, customer, items)
     VALUES ('prestashop', $1, $2, 'pending', $3, $4, $5, $6)
     RETURNING *`,
    [d.ps_order_id.toString(), d.reference || null, d.total, d.currency, d.customer, JSON.stringify(d.items)]
  );

  const order = result.rows[0];

  // Décrémenter le stock pour chaque item (emplacement web)
  for (const item of d.items) {
    if (item.reference) {
      const product = await query("SELECT id FROM products WHERE sku = $1", [item.reference]);
      if (product.rowCount > 0) {
        await query(
          `UPDATE stock SET quantity = GREATEST(0, quantity - $1), updated_at = NOW()
           WHERE product_id = $2 AND location = 'web'`,
          [item.quantity, product.rows[0].id]
        );
      }
    }
  }

  await audit("webhook_order_received", { order_id: order.id, ps_order_id: d.ps_order_id });
  await query(
    "INSERT INTO sync_log(channel, direction, entity, entity_id, status, details) VALUES ('prestashop', 'pull', 'order', $1, 'success', $2)",
    [order.id, { ps_order_id: d.ps_order_id }]
  );

  return res.status(201).json({ order });
});

// ── Webhook : stock PS (info seulement, Peninsula = source de vérité) ──

router.post("/stock", async (req, res) => {
  const parsed = stockWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const { reference, quantity } = parsed.data;
  const product = await query("SELECT id FROM products WHERE sku = $1", [reference]);

  if (product.rowCount > 0) {
    await query(
      "INSERT INTO sync_log(channel, direction, entity, entity_id, status, details) VALUES ('prestashop', 'pull', 'stock', $1, 'success', $2)",
      [product.rows[0].id, { ps_quantity: quantity, reference }]
    );
  }

  return res.json({ success: true, logged: true });
});

export default router;
