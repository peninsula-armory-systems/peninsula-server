import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { requireAuth } from "../middleware.js";

const router = Router();

// ── Schemas ─────────────────────────────────────────────

const orderItemSchema = z.object({
  product_id: z.number().int().optional(),
  sku: z.string().optional(),
  name: z.string(),
  quantity: z.number().int().min(1),
  unit_price: z.number().min(0),
  firearm_id: z.number().int().optional(),
});

const createDirectOrderSchema = z.object({
  customer_id: z.number().int().nullable().optional(),
  items: z.array(orderItemSchema).min(1),
  notes: z.string().default(""),
  payment_method: z.enum(["cash", "card", "transfer", "check"]).optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  source: z.enum(["prestashop", "direct"]).optional(),
  status: z.enum(["pending", "confirmed", "shipped", "delivered", "cancelled", "completed"]).optional(),
  customer_id: z.coerce.number().int().optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(["pending", "confirmed", "shipped", "delivered", "cancelled", "completed"]),
  notes: z.string().optional(),
});

// ── Helpers ─────────────────────────────────────────────

async function audit(actorUserId, action, details = {}) {
  await query(
    "INSERT INTO audits(actor_user_id, action, details) VALUES ($1, $2, $3)",
    [actorUserId || null, action, details]
  );
}

function generateReference() {
  const d = new Date();
  const prefix = `PEN-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
  const rand = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `${prefix}-${rand}`;
}

// ── LIST ────────────────────────────────────────────────

router.get("/", requireAuth, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() });
  }

  const { page, limit, source, status, customer_id } = parsed.data;
  const offset = (page - 1) * limit;
  const conditions = [];
  const values = [];
  let idx = 1;

  if (source) {
    conditions.push(`o.source = $${idx++}`);
    values.push(source);
  }
  if (status) {
    conditions.push(`o.status = $${idx++}`);
    values.push(status);
  }
  if (customer_id) {
    conditions.push(`o.customer_id = $${idx++}`);
    values.push(customer_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await query(`SELECT COUNT(*) FROM orders o ${where}`, values);
  const total = parseInt(countResult.rows[0].count, 10);

  values.push(limit, offset);
  const result = await query(
    `SELECT o.*,
            c.first_name AS customer_first_name, c.last_name AS customer_last_name,
            COALESCE(pay.total_paid, 0) AS total_paid
     FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN LATERAL (
       SELECT SUM(amount) AS total_paid FROM payments WHERE order_id = o.id AND status = 'completed'
     ) pay ON true
     ${where}
     ORDER BY o.created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    values
  );

  return res.json({
    orders: result.rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// ── GET ONE ─────────────────────────────────────────────

router.get("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const result = await query(
    `SELECT o.*, c.first_name AS customer_first_name, c.last_name AS customer_last_name
     FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.id = $1`,
    [id]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });

  const payments = await query(
    "SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at ASC",
    [id]
  );

  return res.json({ order: result.rows[0], payments: payments.rows });
});

// ── CREATE direct order (vente comptoir IRL) ────────────

router.post("/direct", requireAuth, async (req, res) => {
  const parsed = createDirectOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const { customer_id, items, notes, payment_method } = parsed.data;

  // Résoudre les SKUs en product_id et calculer le total
  const resolvedItems = [];
  let total = 0;

  for (const item of items) {
    let productId = item.product_id || null;
    if (!productId && item.sku) {
      const p = await query("SELECT id, name, price FROM products WHERE sku = $1", [item.sku]);
      if (p.rowCount > 0) {
        productId = p.rows[0].id;
      }
    }
    resolvedItems.push({ ...item, product_id: productId });
    total += item.unit_price * item.quantity;
  }

  const reference = generateReference();

  const result = await query(
    `INSERT INTO orders(source, reference, customer_id, status, total, items, notes)
     VALUES ('direct', $1, $2, 'pending', $3, $4, $5)
     RETURNING *`,
    [reference, customer_id || null, total, JSON.stringify(resolvedItems), notes]
  );

  const order = result.rows[0];

  // Décrémenter le stock pour chaque item
  for (const item of resolvedItems) {
    if (item.product_id) {
      await query(
        `UPDATE stock SET quantity = GREATEST(0, quantity - $1), updated_at = NOW()
         WHERE product_id = $2 AND location = (
           SELECT location FROM stock WHERE product_id = $2 ORDER BY quantity DESC LIMIT 1
         )`,
        [item.quantity, item.product_id]
      );
    }

    // Marquer l'arme comme vendue si firearm_id fourni
    if (item.firearm_id && customer_id) {
      await query(
        `UPDATE firearm_records SET status = 'sold', customer_id = $1, sale_date = CURRENT_DATE, updated_at = NOW()
         WHERE id = $2 AND status IN ('in_stock', 'reserved')`,
        [customer_id, item.firearm_id]
      );
    }
  }

  // Paiement immédiat si méthode fournie
  if (payment_method) {
    await query(
      `INSERT INTO payments(order_id, method, amount, status, paid_at)
       VALUES ($1, $2, $3, 'completed', NOW())`,
      [order.id, payment_method, total]
    );
    await query(
      "UPDATE orders SET status = 'completed', updated_at = NOW() WHERE id = $1",
      [order.id]
    );
    order.status = "completed";
  }

  await audit(req.user.sub, "order_created_direct", { order_id: order.id, reference, total, item_count: items.length });
  return res.status(201).json({ order });
});

// ── UPDATE status ───────────────────────────────────────

router.put("/:id/status", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const parsed = updateStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const { status, notes } = parsed.data;
  const updates = ["status = $1", "updated_at = NOW()"];
  const values = [status];
  let idx = 2;

  if (notes !== undefined) {
    updates.push(`notes = $${idx++}`);
    values.push(notes);
  }

  values.push(id);
  const result = await query(
    `UPDATE orders SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );

  if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });

  await audit(req.user.sub, "order_status_updated", { order_id: id, status });
  return res.json({ order: result.rows[0] });
});

export default router;
