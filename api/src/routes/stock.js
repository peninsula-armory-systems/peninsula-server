import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { requireAuth } from "../middleware.js";

const router = Router();

// ── Schemas ─────────────────────────────────────────────

const updateStockSchema = z.object({
  quantity: z.number().int(),
  location: z.string().default("default"),
  mode: z.enum(["set", "adjust"]).default("set"),
});

const lowStockThresholdSchema = z.object({
  location: z.string().default("default"),
  threshold: z.number().int().min(0),
});

// ── Helpers ─────────────────────────────────────────────

async function audit(actorUserId, action, details = {}) {
  await query(
    "INSERT INTO audits(actor_user_id, action, details) VALUES ($1, $2, $3)",
    [actorUserId || null, action, details]
  );
}

// ── GET stock for a product ─────────────────────────────

router.get("/:productId", requireAuth, async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  if (isNaN(productId)) return res.status(400).json({ error: "invalid_id" });

  const product = await query("SELECT id, sku, name FROM products WHERE id = $1", [productId]);
  if (product.rowCount === 0) return res.status(404).json({ error: "product_not_found" });

  const result = await query(
    "SELECT location, quantity, low_stock_threshold, updated_at FROM stock WHERE product_id = $1 ORDER BY location",
    [productId]
  );

  const totalStock = result.rows.reduce((sum, r) => sum + r.quantity, 0);
  const lowStockLocations = result.rows.filter(r => r.quantity <= r.low_stock_threshold);

  return res.json({
    product: product.rows[0],
    stock: result.rows,
    total_stock: totalStock,
    low_stock_alert: lowStockLocations.length > 0,
    low_stock_locations: lowStockLocations,
  });
});

// ── UPDATE stock ────────────────────────────────────────

router.put("/:productId", requireAuth, async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  if (isNaN(productId)) return res.status(400).json({ error: "invalid_id" });

  const parsed = updateStockSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const { quantity, location, mode } = parsed.data;

  const product = await query("SELECT id, sku FROM products WHERE id = $1", [productId]);
  if (product.rowCount === 0) return res.status(404).json({ error: "product_not_found" });

  let result;
  if (mode === "set") {
    // Upsert : set la quantité exacte
    result = await query(
      `INSERT INTO stock(product_id, quantity, location, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT(product_id, location)
       DO UPDATE SET quantity = $2, updated_at = NOW()
       RETURNING *`,
      [productId, quantity, location]
    );
  } else {
    // Adjust : ajouter/retirer du stock (quantity peut être négatif)
    result = await query(
      `INSERT INTO stock(product_id, quantity, location, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT(product_id, location)
       DO UPDATE SET quantity = stock.quantity + $2, updated_at = NOW()
       RETURNING *`,
      [productId, quantity, location]
    );
  }

  const row = result.rows[0];

  await audit(req.user.sub, "stock_updated", {
    product_id: productId,
    sku: product.rows[0].sku,
    location,
    mode,
    quantity,
    new_quantity: row.quantity,
  });

  return res.json({ stock: row });
});

// ── SET low stock threshold ─────────────────────────────

router.put("/:productId/threshold", requireAuth, async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  if (isNaN(productId)) return res.status(400).json({ error: "invalid_id" });

  const parsed = lowStockThresholdSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const { location, threshold } = parsed.data;

  const result = await query(
    `UPDATE stock SET low_stock_threshold = $1, updated_at = NOW()
     WHERE product_id = $2 AND location = $3
     RETURNING *`,
    [threshold, productId, location]
  );

  if (result.rowCount === 0) return res.status(404).json({ error: "stock_entry_not_found" });

  return res.json({ stock: result.rows[0] });
});

// ── GET all low-stock alerts ────────────────────────────

router.get("/alerts/low", requireAuth, async (_req, res) => {
  const result = await query(
    `SELECT s.*, p.sku, p.name
     FROM stock s
     JOIN products p ON p.id = s.product_id
     WHERE s.quantity <= s.low_stock_threshold
     ORDER BY s.quantity ASC`
  );

  return res.json({ alerts: result.rows });
});

export default router;
