import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import bcrypt from "bcrypt";
import { z } from "zod";
import { initDb, query } from "./db.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "./auth.js";
import { requireAdmin, requireAuth } from "./middleware.js";

const app = express();

app.use(helmet());
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));

const api = express.Router();
app.use("/v1", api);

const loginSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(6)
});

const createUserSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(6),
  role: z.enum(["admin", "user"]).default("user")
});

const updateUserSchema = z.object({
  id: z.number().int(),
  password: z.string().min(6).optional(),
  role: z.enum(["admin", "user"]).optional()
});

const deleteUserSchema = z.object({
  id: z.number().int()
});

async function audit(actorUserId, action, details = {}) {
  await query(
    "INSERT INTO audits(actor_user_id, action, details) VALUES ($1, $2, $3)",
    [actorUserId || null, action, details]
  );
}

app.get("/health", async (_req, res) => {
  return res.json({ status: "ok" });
});

api.post("/auth/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  const { username, password } = parsed.data;
  const result = await query("SELECT id, username, password_hash, role FROM users WHERE username = $1", [username]);
  if (result.rowCount === 0) {
    await audit(null, "login_failed", { username });
    return res.status(401).json({ error: "invalid_credentials" });
  }

  const user = result.rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    await audit(user.id, "login_failed", { username });
    return res.status(401).json({ error: "invalid_credentials" });
  }

  const accessToken = signAccessToken({ sub: user.id, role: user.role, username: user.username });
  const refreshToken = signRefreshToken({ sub: user.id, role: user.role });
  await query(
    "INSERT INTO refresh_tokens(user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')",
    [user.id, refreshToken]
  );
  await audit(user.id, "login_success", { username });

  return res.json({ accessToken, refreshToken });
});

api.post("/auth/refresh", async (req, res) => {
  const token = req.body?.refreshToken;
  if (!token) {
    return res.status(400).json({ error: "missing_refresh" });
  }

  try {
    const payload = verifyRefreshToken(token);
    const existing = await query(
      "SELECT id FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()",
      [token]
    );
    if (existing.rowCount === 0) {
      return res.status(401).json({ error: "invalid_refresh" });
    }

    const userResult = await query("SELECT id, username, role FROM users WHERE id = $1", [payload.sub]);
    if (userResult.rowCount === 0) {
      return res.status(401).json({ error: "invalid_refresh" });
    }

    const user = userResult.rows[0];
    const accessToken = signAccessToken({ sub: user.id, role: user.role, username: user.username });
    return res.json({ accessToken });
  } catch {
    return res.status(401).json({ error: "invalid_refresh" });
  }
});

api.get("/admin/users/list", requireAuth, requireAdmin, async (req, res) => {
  const result = await query("SELECT id, username, role, created_at FROM users ORDER BY id ASC", []);
  await audit(req.user.sub, "users_list", {});
  return res.json({ users: result.rows });
});

api.post("/admin/users/create", requireAuth, requireAdmin, async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  const { username, password, role } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const result = await query(
      "INSERT INTO users(username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, created_at",
      [username, passwordHash, role]
    );
    await audit(req.user.sub, "user_created", { username, role });
    return res.json({ user: result.rows[0] });
  } catch (error) {
    return res.status(409).json({ error: "user_exists" });
  }
});

api.post("/admin/users/update", requireAuth, requireAdmin, async (req, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  const { id, password, role } = parsed.data;
  const updates = [];
  const values = [];
  let index = 1;

  if (password) {
    const hash = await bcrypt.hash(password, 10);
    updates.push(`password_hash = $${index++}`);
    values.push(hash);
  }
  if (role) {
    updates.push(`role = $${index++}`);
    values.push(role);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: "no_updates" });
  }

  values.push(id);

  const result = await query(
    `UPDATE users SET ${updates.join(", ")} WHERE id = $${index} RETURNING id, username, role, created_at`,
    values
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: "not_found" });
  }

  await audit(req.user.sub, "user_updated", { id, role: role || null });
  return res.json({ user: result.rows[0] });
});

api.post("/admin/users/delete", requireAuth, requireAdmin, async (req, res) => {
  const parsed = deleteUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  const { id } = parsed.data;
  if (id === req.user.sub) {
    return res.status(400).json({ error: "cannot_delete_self" });
  }

  const result = await query("DELETE FROM users WHERE id = $1 RETURNING id", [id]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: "not_found" });
  }

  await audit(req.user.sub, "user_deleted", { id });
  return res.json({ success: true });
});

const port = Number(process.env.PORT || 4875);

initDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`Peninsula API running on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("Database init failed", error);
    process.exit(1);
  });
