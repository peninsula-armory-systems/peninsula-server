import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { requireAuth } from "../middleware.js";

const router = Router();

// ── Schemas ─────────────────────────────────────────────

const createCategorySchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  parent_id: z.number().int().nullable().default(null),
});

const updateCategorySchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
  parent_id: z.number().int().nullable().optional(),
});

// ── LIST ────────────────────────────────────────────────

router.get("/", requireAuth, async (_req, res) => {
  const result = await query(
    `SELECT c.*, p.name AS parent_name,
            (SELECT COUNT(*) FROM products WHERE category_id = c.id) AS product_count
     FROM categories c
     LEFT JOIN categories p ON p.id = c.parent_id
     ORDER BY c.name ASC`
  );
  return res.json({ categories: result.rows });
});

// ── CREATE ──────────────────────────────────────────────

router.post("/", requireAuth, async (req, res) => {
  const parsed = createCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
  }

  const { name, slug, parent_id } = parsed.data;

  try {
    const result = await query(
      "INSERT INTO categories(name, slug, parent_id) VALUES ($1, $2, $3) RETURNING *",
      [name, slug, parent_id]
    );
    return res.status(201).json({ category: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "slug_exists" });
    }
    throw error;
  }
});

// ── UPDATE ──────────────────────────────────────────────

router.put("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const parsed = updateCategorySchema.safeParse(req.body);
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

  values.push(id);
  const result = await query(
    `UPDATE categories SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );

  if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });
  return res.json({ category: result.rows[0] });
});

// ── DELETE ──────────────────────────────────────────────

router.delete("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid_id" });

  const result = await query("DELETE FROM categories WHERE id = $1 RETURNING id", [id]);
  if (result.rowCount === 0) return res.status(404).json({ error: "not_found" });

  return res.json({ success: true });
});

export default router;
