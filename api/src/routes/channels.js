import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { requireAuth } from "../middleware.js";

const router = Router();

// ── Schemas ─────────────────────────────────────────────

const publishSchema = z.object({
  channel: z.enum(["prestashop", "naturabuy"]),
  published: z.boolean(),
  sale_price: z.number().min(0).nullable().optional(),
});

// ── Helpers ─────────────────────────────────────────────

async function audit(actorUserId, action, details = {}) {
  await query(
    "INSERT INTO audits(actor_user_id, action, details) VALUES ($1, $2, $3)",
    [actorUserId || null, action, details]
  );
}

// ── Publish / unpublish a product on a channel ──────────

router.put("/:productId", requireAuth, async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  if (isNaN(productId)) return res.status(400).json({ error: "invalid_id" });

  const parsed = publishSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const { channel, published, sale_price } = parsed.data;

  const product = await query("SELECT id, sku, name, price FROM products WHERE id = $1", [productId]);
  if (product.rowCount === 0) return res.status(404).json({ error: "product_not_found" });

  const effectivePrice = sale_price !== undefined && sale_price !== null ? sale_price : product.rows[0].price;

  const result = await query(
    `INSERT INTO product_channels(product_id, channel, published, sale_price, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT(product_id, channel)
     DO UPDATE SET published = $3, sale_price = $4, updated_at = NOW()
     RETURNING *`,
    [productId, channel, published, effectivePrice]
  );

  await audit(req.user.sub, "product_channel_updated", {
    product_id: productId,
    sku: product.rows[0].sku,
    channel,
    published,
    sale_price: effectivePrice,
  });

  return res.json({ channel: result.rows[0] });
});

// ── GET published products for a channel (used by PS module) ──

router.get("/channel/:channel", requireAuth, async (req, res) => {
  const channel = req.params.channel;
  if (!["prestashop", "naturabuy"].includes(channel)) {
    return res.status(400).json({ error: "invalid_channel" });
  }

  const sinceParam = req.query.since;
  const conditions = ["pc.channel = $1", "pc.published = true"];
  const values = [channel];
  let idx = 2;

  if (sinceParam) {
    conditions.push(`p.updated_at > $${idx++}`);
    values.push(sinceParam);
  }

  const result = await query(
    `SELECT p.*, pc.sale_price, pc.external_id, pc.last_synced_at,
            c.name AS category_name,
            COALESCE(s.total_stock, 0) AS total_stock
     FROM products p
     JOIN product_channels pc ON pc.product_id = p.id
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN LATERAL (
       SELECT SUM(quantity) AS total_stock FROM stock WHERE product_id = p.id
     ) s ON true
     WHERE ${conditions.join(" AND ")}
     ORDER BY p.updated_at DESC`,
    values
  );

  return res.json({ products: result.rows });
});

// ── Mark a product as synced on a channel ───────────────

router.post("/:productId/synced", requireAuth, async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  if (isNaN(productId)) return res.status(400).json({ error: "invalid_id" });

  const channel = req.body.channel;
  const externalId = req.body.external_id;

  if (!channel || !["prestashop", "naturabuy"].includes(channel)) {
    return res.status(400).json({ error: "invalid_channel" });
  }

  const result = await query(
    `UPDATE product_channels
     SET last_synced_at = NOW(), external_id = COALESCE($3, external_id), sync_error = NULL, updated_at = NOW()
     WHERE product_id = $1 AND channel = $2
     RETURNING *`,
    [productId, channel, externalId || null]
  );

  if (result.rowCount === 0) return res.status(404).json({ error: "channel_entry_not_found" });

  // Log sync
  await query(
    "INSERT INTO sync_log(channel, direction, entity, entity_id, status, details) VALUES ($1, 'push', 'product', $2, 'success', $3)",
    [channel, productId, { external_id: externalId }]
  );

  return res.json({ channel: result.rows[0] });
});

// ── Mark a sync error ───────────────────────────────────

router.post("/:productId/sync-error", requireAuth, async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  if (isNaN(productId)) return res.status(400).json({ error: "invalid_id" });

  const { channel, error: syncError } = req.body;

  if (!channel || !["prestashop", "naturabuy"].includes(channel)) {
    return res.status(400).json({ error: "invalid_channel" });
  }

  await query(
    `UPDATE product_channels SET sync_error = $3, updated_at = NOW()
     WHERE product_id = $1 AND channel = $2`,
    [productId, channel, syncError || "unknown"]
  );

  await query(
    "INSERT INTO sync_log(channel, direction, entity, entity_id, status, details) VALUES ($1, 'push', 'product', $2, 'error', $3)",
    [channel, productId, { error: syncError }]
  );

  return res.json({ success: true });
});

export default router;
