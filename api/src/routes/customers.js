import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { requireAuth } from "../middleware.js";

const router = Router();

// ── Schemas ─────────────────────────────────────────────

const addressSchema = z.object({
  street: z.string().default(""),
  city: z.string().default(""),
  zip: z.string().default(""),
  country: z.string().default("FR"),
}).default({});

const createCustomerSchema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: addressSchema,
  type: z.enum(["individual", "professional"]).default("individual"),
  license_number: z.string().nullable().optional(),
  license_expiry: z.string().nullable().optional(),
  id_document: z.string().nullable().optional(),
  notes: z.string().default(""),
});

const updateCustomerSchema = z.object({
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: addressSchema.optional(),
  type: z.enum(["individual", "professional"]).optional(),
  license_number: z.string().nullable().optional(),
  license_expiry: z.string().nullable().optional(),
  id_document: z.string().nullable().optional(),
  notes: z.string().optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().optional(),
  type: z.enum(["individual", "professional"]).optional(),
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

  const { page, limit, search, type } = parsed.data;
  const offset = (page - 1) * limit;
  const conditions = [];
  const values = [];
  let idx = 1;

  if (search) {
    conditions.push(`(c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx} OR c.email ILIKE $${idx} OR c.phone ILIKE $${idx} OR c.license_number ILIKE $${idx})`);
    values.push(`%${search}%`);
    idx++;
  }
  if (type) {
    conditions.push(`c.type = $${idx++}`);
    values.push(type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await query(`SELECT COUNT(*) FROM customers c ${where}`, values);
  const total = parseInt(countResult.rows[0].count, 10);

  values.push(limit, offset);
  const result = await query(
    `SELECT c.*,
            (SELECT COUNT(*) FROM orders WHERE customer_id = c.id) AS order_count,
            (SELECT COUNT(*) FROM firearm_records WHERE customer_id = c.id) AS firearm_count
     FROM customers c
     ${where}
     ORDER BY c.last_name ASC, c.first_name ASC
     LIMIT $${idx++} OFFSET $${idx++}`,
    values
  );

  return res.json({
    customers: result.rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// ── GET ONE ─────────────────────────────────────────────

router.get("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const result = await query("SELECT * FROM customers WHERE id = $1", [id]);
  if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });

  // Commandes du client
  const orders = await query(
    "SELECT id, source, reference, status, total, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20",
    [id]
  );

  // Armes achetées par ce client
  const firearms = await query(
    `SELECT fr.id, fr.serial_number, fr.manufacturer, fr.model, fr.caliber, fr.category, fr.status, fr.sale_date,
            p.name AS product_name
     FROM firearm_records fr
     LEFT JOIN products p ON p.id = fr.product_id
     WHERE fr.customer_id = $1
     ORDER BY fr.sale_date DESC`,
    [id]
  );

  return res.json({
    customer: result.rows[0],
    orders: orders.rows,
    firearms: firearms.rows,
  });
});

// ── CREATE ──────────────────────────────────────────────

router.post("/", requireAuth, async (req, res) => {
  const parsed = createCustomerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const d = parsed.data;
  const result = await query(
    `INSERT INTO customers(first_name, last_name, email, phone, address, type, license_number, license_expiry, id_document, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [d.first_name, d.last_name, d.email || null, d.phone || null, d.address, d.type, d.license_number || null, d.license_expiry || null, d.id_document || null, d.notes]
  );

  await audit(req.user.sub, "customer_created", { id: result.rows[0].id, name: `${d.first_name} ${d.last_name}` });
  return res.status(201).json({ customer: result.rows[0] });
});

// ── UPDATE ──────────────────────────────────────────────

router.put("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const parsed = updateCustomerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const fields = parsed.data;
  const updates = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      updates.push(`${key} = $${idx++}`);
      values.push(value);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: "no_updates" });
  }

  updates.push("updated_at = NOW()");
  values.push(id);

  const result = await query(
    `UPDATE customers SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );

  if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });

  await audit(req.user.sub, "customer_updated", { id, fields: Object.keys(fields) });
  return res.json({ customer: result.rows[0] });
});

// ── DELETE ──────────────────────────────────────────────

router.delete("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const result = await query("DELETE FROM customers WHERE id = $1 RETURNING id, first_name, last_name", [id]);
  if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });

  await audit(req.user.sub, "customer_deleted", { id, name: `${result.rows[0].first_name} ${result.rows[0].last_name}` });
  return res.json({ success: true });
});

export default router;
