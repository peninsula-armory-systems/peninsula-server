import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import bcrypt from "bcrypt";
import { z } from "zod";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";
import { initDb, query } from "./db.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "./auth.js";
import { requireAdmin, requireAuth } from "./middleware.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_DIR = process.env.REPO_DIR || path.resolve(__dirname, "../../..");

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

// ── Update module ──────────────────────────────────────────────────────────

api.get("/admin/update/check", requireAuth, requireAdmin, async (req, res) => {
  try {
    // Get local HEAD
    const { stdout: localHash } = await execFileAsync("git", ["-C", REPO_DIR, "rev-parse", "HEAD"]);
    const { stdout: localMsg } = await execFileAsync("git", ["-C", REPO_DIR, "log", "-1", "--format=%s"]);
    const { stdout: localDate } = await execFileAsync("git", ["-C", REPO_DIR, "log", "-1", "--format=%ci"]);
    const { stdout: branch } = await execFileAsync("git", ["-C", REPO_DIR, "rev-parse", "--abbrev-ref", "HEAD"]);

    // Fetch remote
    await execFileAsync("git", ["-C", REPO_DIR, "fetch", "origin"]);

    // Get remote HEAD
    const remoteBranch = `origin/${branch.trim()}`;
    const { stdout: remoteHash } = await execFileAsync("git", ["-C", REPO_DIR, "rev-parse", remoteBranch]);
    const { stdout: remoteMsg } = await execFileAsync("git", ["-C", REPO_DIR, "log", "-1", "--format=%s", remoteBranch]);
    const { stdout: remoteDate } = await execFileAsync("git", ["-C", REPO_DIR, "log", "-1", "--format=%ci", remoteBranch]);

    // Count commits behind
    const { stdout: behindCount } = await execFileAsync("git", ["-C", REPO_DIR, "rev-list", "--count", `HEAD..${remoteBranch}`]);

    await audit(req.user.sub, "update_check", {});

    return res.json({
      updateAvailable: localHash.trim() !== remoteHash.trim(),
      commitsBehind: Number(behindCount.trim()),
      branch: branch.trim(),
      local: {
        hash: localHash.trim().substring(0, 8),
        message: localMsg.trim(),
        date: localDate.trim()
      },
      remote: {
        hash: remoteHash.trim().substring(0, 8),
        message: remoteMsg.trim(),
        date: remoteDate.trim()
      }
    });
  } catch (error) {
    console.error("Update check failed:", error);
    return res.status(500).json({ error: "update_check_failed", details: error.message });
  }
});

let updateInProgress = false;

api.post("/admin/update/apply", requireAuth, requireAdmin, async (req, res) => {
  if (updateInProgress) {
    return res.status(409).json({ error: "update_already_in_progress" });
  }

  updateInProgress = true;

  try {
    const scriptPath = path.resolve(REPO_DIR, "scripts/update.sh");

    await audit(req.user.sub, "update_apply", {});

    const result = await new Promise((resolve, reject) => {
      const child = spawn("sudo", ["bash", scriptPath], {
        cwd: REPO_DIR,
        timeout: 120_000
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => { stdout += data.toString(); });
      child.stderr.on("data", (data) => { stderr += data.toString(); });

      child.on("close", (code) => {
        resolve({ code, stdout, stderr });
      });

      child.on("error", (err) => {
        reject(err);
      });
    });

    updateInProgress = false;

    if (result.code !== 0) {
      return res.status(500).json({
        error: "update_script_failed",
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr
      });
    }

    return res.json({
      success: true,
      output: result.stdout
    });
  } catch (error) {
    updateInProgress = false;
    console.error("Update apply failed:", error);
    return res.status(500).json({ error: "update_apply_failed", details: error.message });
  }
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
