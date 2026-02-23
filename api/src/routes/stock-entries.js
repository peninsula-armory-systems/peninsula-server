import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { requireAuth } from "../middleware.js";

const router = Router();

// ── Schemas ─────────────────────────────────────────────

const entryItemSchema = z.object({
  product_id: z.number().int().optional(),
  sku: z.string().optional(),
  name: z.string(),
  quantity: z.number().int().min(1),
  unit_cost: z.number().min(0).default(0),
  serial_numbers: z.array(z.string()).default([]),
});

const createEntrySchema = z.object({
  supplier: z.string().min(1),
  reference: z.string().nullable().optional(),
  items: z.array(entryItemSchema).min(1),
  notes: z.string().default(""),
});

const receiveSchema = z.object({
  received_items: z.array(z.object({
    index: z.number().int().min(0),
    quantity_received: z.number().int().min(0),
    location: z.string().default("default"),
  })),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(["pending", "received", "partial"]).optional(),
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

  const { page, limit, status } = parsed.data;
  const offset = (page - 1) * limit;
  const conditions = [];
  const values = [];
  let idx = 1;

  if (status) {
    conditions.push(`status = $${idx++}`);
    values.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await query(`SELECT COUNT(*) FROM stock_entries ${where}`, values);
  const total = parseInt(countResult.rows[0].count, 10);

  values.push(limit, offset);
  const result = await query(
    `SELECT se.*, u.username AS received_by_name
     FROM stock_entries se
     LEFT JOIN users u ON u.id = se.received_by
     ${where}
     ORDER BY se.created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    values
  );

  return res.json({
    entries: result.rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// ── GET ONE ─────────────────────────────────────────────

router.get("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const result = await query(
    `SELECT se.*, u.username AS received_by_name
     FROM stock_entries se
     LEFT JOIN users u ON u.id = se.received_by
     WHERE se.id = $1`,
    [id]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });

  return res.json({ entry: result.rows[0] });
});

// ── CREATE (nouvelle commande fournisseur) ──────────────

router.post("/", requireAuth, async (req, res) => {
  const parsed = createEntrySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const { supplier, reference, items, notes } = parsed.data;

  // Résoudre les product_id par SKU si non fourni
  const resolvedItems = [];
  for (const item of items) {
    let productId = item.product_id || null;
    if (!productId && item.sku) {
      const product = await query("SELECT id FROM products WHERE sku = $1", [item.sku]);
      if (product.rowCount > 0) productId = product.rows[0].id;
    }
    resolvedItems.push({ ...item, product_id: productId });
  }

  const result = await query(
    `INSERT INTO stock_entries(supplier, reference, status, items, notes)
     VALUES ($1, $2, 'pending', $3, $4)
     RETURNING *`,
    [supplier, reference || null, JSON.stringify(resolvedItems), notes]
  );

  await audit(req.user.sub, "stock_entry_created", { id: result.rows[0].id, supplier, item_count: items.length });
  return res.status(201).json({ entry: result.rows[0] });
});

// ── RECEIVE (réceptionner les articles) ─────────────────

router.post("/:id/receive", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const parsed = receiveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const entry = await query("SELECT * FROM stock_entries WHERE id = $1", [id]);
  if (entry.rowCount === 0) return res.status(404).json({ error: "not_found" });
  if (entry.rows[0].status === "received") return res.status(400).json({ error: "already_fully_received" });

  const items = entry.rows[0].items;
  let allReceived = true;

  for (const recv of parsed.data.received_items) {
    if (recv.index < 0 || recv.index >= items.length) continue;

    const item = items[recv.index];
    const qtyReceived = Math.min(recv.quantity_received, item.quantity);
    items[recv.index].quantity_received = (item.quantity_received || 0) + qtyReceived;

    if (items[recv.index].quantity_received < item.quantity) {
      allReceived = false;
    }

    // Mettre à jour le stock si le produit existe
    if (item.product_id) {
      await query(
        `INSERT INTO stock(product_id, quantity, location, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT(product_id, location)
         DO UPDATE SET quantity = stock.quantity + $2, updated_at = NOW()`,
        [item.product_id, qtyReceived, recv.location]
      );
    }

    // Créer les enregistrements d'armes si des numéros de série sont fournis
    if (item.serial_numbers && item.serial_numbers.length > 0) {
      for (const sn of item.serial_numbers) {
        await query(
          `INSERT INTO firearm_records(product_id, serial_number, supplier, purchase_price, stock_entry_id, entry_date)
           VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)
           ON CONFLICT(serial_number) DO NOTHING`,
          [item.product_id || null, sn, entry.rows[0].supplier, item.unit_cost || 0, id]
        );
      }
    }
  }

  const newStatus = allReceived ? "received" : "partial";

  await query(
    `UPDATE stock_entries SET items = $1, status = $2, received_by = $3, received_at = NOW(), updated_at = NOW()
     WHERE id = $4`,
    [JSON.stringify(items), newStatus, req.user.sub, id]
  );

  await audit(req.user.sub, "stock_entry_received", { id, status: newStatus });

  const updated = await query("SELECT * FROM stock_entries WHERE id = $1", [id]);
  return res.json({ entry: updated.rows[0] });
});

export default router;
