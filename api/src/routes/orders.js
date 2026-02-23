import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { requireAuth } from "../middleware.js";

const router = Router();

// ── LIST orders ─────────────────────────────────────────

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  source: z.enum(["prestashop", "naturabuy", "direct"]).optional(),
  status: z.enum(["pending", "confirmed", "shipped", "delivered", "cancelled"]).optional(),
});

router.get("/", requireAuth, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() });
  }

  const { page, limit, source, status } = parsed.data;
  const offset = (page - 1) * limit;
  const conditions = [];
  const values = [];
  let idx = 1;

  if (source) {
    conditions.push(`source = $${idx++}`);
    values.push(source);
  }
  if (status) {
    conditions.push(`status = $${idx++}`);
    values.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await query(`SELECT COUNT(*) FROM orders ${where}`, values);
  const total = parseInt(countResult.rows[0].count, 10);

  values.push(limit, offset);
  const result = await query(
    `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
    values
  );

  return res.json({
    orders: result.rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// ── GET one order ───────────────────────────────────────

router.get("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const result = await query("SELECT * FROM orders WHERE id = $1", [id]);
  if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });

  return res.json({ order: result.rows[0] });
});

// ── UPDATE order status ─────────────────────────────────

const updateStatusSchema = z.object({
  status: z.enum(["pending", "confirmed", "shipped", "delivered", "cancelled"]),
  notes: z.string().optional(),
});

router.put("/:id/status", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const parsed = updateStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const { status, notes } = parsed.data;
  const updates = [`status = $1`, `updated_at = NOW()`];
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

  await query(
    "INSERT INTO audits(actor_user_id, action, details) VALUES ($1, $2, $3)",
    [req.user.sub, "order_status_updated", { order_id: id, status }]
  );

  return res.json({ order: result.rows[0] });
});

export default router;
