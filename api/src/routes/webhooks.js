import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";

const router = Router();

// ── Schemas ─────────────────────────────────────────────

const orderWebhookSchema = z.object({
  source: z.enum(["prestashop", "naturabuy"]),
  ps_order_id: z.number().int().optional(),
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
  source: z.enum(["prestashop", "naturabuy"]),
  ps_product_id: z.number().int().optional(),
  reference: z.string().optional(),
  quantity: z.number().int(),
});

// ── Helpers ─────────────────────────────────────────────

async function audit(actorUserId, action, details = {}) {
  await query(
    "INSERT INTO audits(actor_user_id, action, details) VALUES ($1, $2, $3)",
    [actorUserId || null, action, details]
  );
}

// ── Webhook : nouvelle commande depuis PrestaShop ───────

router.post("/order", async (req, res) => {
  const parsed = orderWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const d = parsed.data;

  // Créer la commande dans Peninsula
  const result = await query(
    `INSERT INTO orders(source, external_order_id, reference, status, total, currency, customer, items)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)
     RETURNING *`,
    [d.source, d.ps_order_id?.toString() || null, d.reference || null, d.total, d.currency, d.customer, JSON.stringify(d.items)]
  );

  const order = result.rows[0];

  // Décrémenter le stock pour chaque item
  for (const item of d.items) {
    if (item.reference) {
      // Trouver le produit Peninsula par SKU (reference)
      const product = await query("SELECT id FROM products WHERE sku = $1", [item.reference]);
      if (product.rowCount > 0) {
        await query(
          `UPDATE stock SET quantity = GREATEST(0, quantity - $1), updated_at = NOW()
           WHERE product_id = $2 AND location = (
             SELECT location FROM stock WHERE product_id = $2 ORDER BY quantity DESC LIMIT 1
           )`,
          [item.quantity, product.rows[0].id]
        );
      }
    }
  }

  await audit(null, "order_received", { source: d.source, order_id: order.id, external_id: d.ps_order_id });

  // Log sync
  await query(
    "INSERT INTO sync_log(channel, direction, entity, entity_id, status, details) VALUES ($1, 'pull', 'order', $2, 'success', $3)",
    [d.source, order.id, { external_order_id: d.ps_order_id }]
  );

  return res.status(201).json({ order });
});

// ── Webhook : mise à jour stock depuis PrestaShop ───────

router.post("/stock", async (req, res) => {
  const parsed = stockWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const { source, reference, quantity } = parsed.data;

  if (!reference) {
    return res.status(400).json({ error: "missing_reference" });
  }

  // Trouver le produit par SKU
  const product = await query("SELECT id, sku FROM products WHERE sku = $1", [reference]);
  if (product.rowCount === 0) {
    return res.status(404).json({ error: "product_not_found", reference });
  }

  const productId = product.rows[0].id;

  // On ne met PAS à jour le stock Peninsula automatiquement depuis PS
  // car Peninsula = source de vérité. On log juste pour info.
  await query(
    "INSERT INTO sync_log(channel, direction, entity, entity_id, status, details) VALUES ($1, 'pull', 'stock', $2, 'success', $3)",
    [source, productId, { ps_quantity: quantity, reference }]
  );

  return res.json({ success: true, message: "stock_notification_logged" });
});

export default router;
