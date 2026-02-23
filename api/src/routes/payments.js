import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { requireAuth } from "../middleware.js";

const router = Router();

// ── Schemas ─────────────────────────────────────────────

const addPaymentSchema = z.object({
  order_id: z.number().int(),
  method: z.enum(["cash", "card", "transfer", "check"]),
  amount: z.number().min(0),
  reference: z.string().nullable().optional(),
});

const refundSchema = z.object({
  reason: z.string().default(""),
});

// ── Helpers ─────────────────────────────────────────────

async function audit(actorUserId, action, details = {}) {
  await query(
    "INSERT INTO audits(actor_user_id, action, details) VALUES ($1, $2, $3)",
    [actorUserId || null, action, details]
  );
}

// ── GET payments for an order ───────────────────────────

router.get("/order/:orderId", requireAuth, async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  if (isNaN(orderId)) return res.status(400).json({ error: "invalid_id" });

  const order = await query("SELECT id, total, status FROM orders WHERE id = $1", [orderId]);
  if (order.rowCount === 0) return res.status(404).json({ error: "order_not_found" });

  const payments = await query(
    "SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at ASC",
    [orderId]
  );

  const totalPaid = payments.rows
    .filter(p => p.status === "completed")
    .reduce((sum, p) => sum + parseFloat(p.amount), 0);

  const orderTotal = parseFloat(order.rows[0].total);

  return res.json({
    order_id: orderId,
    order_total: orderTotal,
    total_paid: totalPaid,
    remaining: Math.max(0, orderTotal - totalPaid),
    fully_paid: totalPaid >= orderTotal,
    payments: payments.rows,
  });
});

// ── ADD payment ─────────────────────────────────────────

router.post("/", requireAuth, async (req, res) => {
  const parsed = addPaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const { order_id, method, amount, reference } = parsed.data;

  const order = await query("SELECT id, total FROM orders WHERE id = $1", [order_id]);
  if (order.rowCount === 0) return res.status(404).json({ error: "order_not_found" });

  const result = await query(
    `INSERT INTO payments(order_id, method, amount, status, reference, paid_at)
     VALUES ($1, $2, $3, 'completed', $4, NOW())
     RETURNING *`,
    [order_id, method, amount, reference || null]
  );

  // Vérifier si la commande est entièrement payée
  const allPayments = await query(
    "SELECT SUM(amount) AS paid FROM payments WHERE order_id = $1 AND status = 'completed'",
    [order_id]
  );
  const totalPaid = parseFloat(allPayments.rows[0].paid || 0);
  const orderTotal = parseFloat(order.rows[0].total);

  if (totalPaid >= orderTotal) {
    await query(
      "UPDATE orders SET status = 'confirmed', updated_at = NOW() WHERE id = $1 AND status = 'pending'",
      [order_id]
    );
  }

  await audit(req.user.sub, "payment_added", { order_id, method, amount });
  return res.status(201).json({ payment: result.rows[0], fully_paid: totalPaid >= orderTotal });
});

// ── REFUND a payment ────────────────────────────────────

router.post("/:id/refund", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const parsed = refundSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  const result = await query(
    "UPDATE payments SET status = 'refunded' WHERE id = $1 AND status = 'completed' RETURNING *",
    [id]
  );

  if (result.rowCount === 0) return res.status(404).json({ error: "payment_not_found_or_already_refunded" });

  await audit(req.user.sub, "payment_refunded", { payment_id: id, amount: result.rows[0].amount, reason: parsed.data.reason });
  return res.json({ payment: result.rows[0] });
});

export default router;
