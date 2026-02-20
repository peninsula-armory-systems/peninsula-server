import "dotenv/config";
import bcrypt from "bcrypt";
import { initDb, query } from "../src/db.js";

const username = process.argv[2] || "admin";
const password = process.argv[3] || "admin123";

async function run() {
  await initDb();

  const existing = await query("SELECT id FROM users WHERE username = $1", [username]);
  if (existing.rowCount > 0) {
    console.log("Admin already exists");
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await query(
    "INSERT INTO users(username, password_hash, role) VALUES ($1, $2, 'admin')",
    [username, passwordHash]
  );
  console.log("Admin created", username);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
