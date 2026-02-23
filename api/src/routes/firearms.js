import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { requireAuth } from "../middleware.js";

const router = Router();

// ── Schemas ─────────────────────────────────────────────

const CATEGORIES = ["A", "A1", "B", "C", "D"];
const STATUSES = ["in_stock", "reserved", "sold", "transferred", "returned_supplier", "destroyed"];

const createFirearmSchema = z.object({
  product_id: z.number().int().nullable().optional(),
  serial_number: z.string().min(1),
  manufacturer: z.string().min(1),
  model: z.string().min(1),
  caliber: z.string().min(1),
  category: z.enum(CATEGORIES).default("C"),
  supplier: z.string().default(""),
  purchase_price: z.number().min(0).default(0),
  entry_date: z.string().optional(),
  notes: z.string().default(""),
});

const updateFirearmSchema = z.object({
  status: z.enum(STATUSES).optional(),
  customer_id: z.number().int().nullable().optional(),
  sale_date: z.string().nullable().optional(),
  notes: z.string().optional(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  caliber: z.string().optional(),
  category: z.enum(CATEGORIES).optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(STATUSES).optional(),
  category: z.enum(CATEGORIES).optional(),
  search: z.string().optional(),
  customer_id: z.coerce.number().int().optional(),
});

const sellSchema = z.object({
  customer_id: z.number().int(),
  sale_date: z.string().optional(),
  order_id: z.number().int().optional(),
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

  const { page, limit, status, category, search, customer_id } = parsed.data;
  const offset = (page - 1) * limit;
  const conditions = [];
  const values = [];
  let idx = 1;

  if (status) {
    conditions.push(`fr.status = $${idx++}`);
    values.push(status);
  }
  if (category) {
    conditions.push(`fr.category = $${idx++}`);
    values.push(category);
  }
  if (search) {
    conditions.push(`(fr.serial_number ILIKE $${idx} OR fr.manufacturer ILIKE $${idx} OR fr.model ILIKE $${idx} OR fr.caliber ILIKE $${idx})`);
    values.push(`%${search}%`);
    idx++;
  }
  if (customer_id) {
    conditions.push(`fr.customer_id = $${idx++}`);
    values.push(customer_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await query(`SELECT COUNT(*) FROM firearm_records fr ${where}`, values);
  const total = parseInt(countResult.rows[0].count, 10);

  values.push(limit, offset);
  const result = await query(
    `SELECT fr.*,
            p.name AS product_name, p.sku AS product_sku,
            c.first_name AS customer_first_name, c.last_name AS customer_last_name
     FROM firearm_records fr
     LEFT JOIN products p ON p.id = fr.product_id
     LEFT JOIN customers c ON c.id = fr.customer_id
     ${where}
     ORDER BY fr.entry_date DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    values
  );

  return res.json({
    firearms: result.rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// ── GET ONE ─────────────────────────────────────────────

router.get("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const result = await query(
    `SELECT fr.*,
            p.name AS product_name, p.sku AS product_sku, p.price AS product_price,
            c.first_name AS customer_first_name, c.last_name AS customer_last_name,
            c.license_number AS customer_license, c.id_document AS customer_id_document
     FROM firearm_records fr
     LEFT JOIN products p ON p.id = fr.product_id
     LEFT JOIN customers c ON c.id = fr.customer_id
     WHERE fr.id = $1`,
    [id]
  );

  if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });
  return res.json({ firearm: result.rows[0] });
});

// ── SEARCH by serial number ─────────────────────────────

router.get("/serial/:serial", requireAuth, async (req, res) => {
  const serial = req.params.serial;

  const result = await query(
    `SELECT fr.*,
            p.name AS product_name, p.sku AS product_sku,
            c.first_name AS customer_first_name, c.last_name AS customer_last_name
     FROM firearm_records fr
     LEFT JOIN products p ON p.id = fr.product_id
     LEFT JOIN customers c ON c.id = fr.customer_id
     WHERE fr.serial_number = $1`,
    [serial]
  );

  if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });
  return res.json({ firearm: result.rows[0] });
});

// ── CREATE ──────────────────────────────────────────────

router.post("/", requireAuth, async (req, res) => {
  const parsed = createFirearmSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const d = parsed.data;

  try {
    const result = await query(
      `INSERT INTO firearm_records(product_id, serial_number, manufacturer, model, caliber, category, supplier, purchase_price, entry_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [d.product_id || null, d.serial_number, d.manufacturer, d.model, d.caliber, d.category, d.supplier, d.purchase_price, d.entry_date || new Date().toISOString().split("T")[0], d.notes]
    );

    await audit(req.user.sub, "firearm_created", { id: result.rows[0].id, serial: d.serial_number, model: d.model });
    return res.status(201).json({ firearm: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "serial_number_exists" });
    }
    throw error;
  }
});

// ── UPDATE ──────────────────────────────────────────────

router.put("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const parsed = updateFirearmSchema.safeParse(req.body);
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
    `UPDATE firearm_records SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );

  if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });

  await audit(req.user.sub, "firearm_updated", { id, fields: Object.keys(fields) });
  return res.json({ firearm: result.rows[0] });
});

// ── SELL (vente à un client) ────────────────────────────

router.post("/:id/sell", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const parsed = sellSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const { customer_id, sale_date, order_id } = parsed.data;

  // Vérifier que l'arme est en stock
  const firearm = await query("SELECT * FROM firearm_records WHERE id = $1", [id]);
  if (firearm.rowCount === 0) return res.status(404).json({ error: "not_found" });
  if (firearm.rows[0].status !== "in_stock" && firearm.rows[0].status !== "reserved") {
    return res.status(400).json({ error: "firearm_not_available", current_status: firearm.rows[0].status });
  }

  // Vérifier que le client existe
  const customer = await query("SELECT id, first_name, last_name, license_number FROM customers WHERE id = $1", [customer_id]);
  if (customer.rowCount === 0) return res.status(404).json({ error: "customer_not_found" });

  // Vérifier que le client a un permis pour cat A/B
  const cat = firearm.rows[0].category;
  if (["A", "A1", "B"].includes(cat) && !customer.rows[0].license_number) {
    return res.status(400).json({ error: "customer_license_required", category: cat });
  }

  const result = await query(
    `UPDATE firearm_records SET status = 'sold', customer_id = $1, sale_date = $2, updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [customer_id, sale_date || new Date().toISOString().split("T")[0], id]
  );

  await audit(req.user.sub, "firearm_sold", {
    firearm_id: id,
    serial: firearm.rows[0].serial_number,
    customer_id,
    customer_name: `${customer.rows[0].first_name} ${customer.rows[0].last_name}`,
    order_id: order_id || null,
  });

  return res.json({ firearm: result.rows[0] });
});

export default router;
