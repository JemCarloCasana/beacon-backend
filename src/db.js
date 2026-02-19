import dotenv from "dotenv";
dotenv.config();

import pg from "pg";
const { Pool } = pg;

// Validate DATABASE_URL on startup
if (!process.env.DATABASE_URL) {
  console.warn("⚠️  DATABASE_URL is not set - database connection will fail");
} else {
  console.log("✓ DATABASE_URL configured");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Connection error handler - logs but doesn't crash
pool.on("error", (err) => {
  console.error("❌ Unexpected error on idle client in pool:", err.message);
});

// Log successful connection
pool.on("connect", () => {
  console.log("✅ Database connection established");
});

// Graceful shutdown handlers
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing database pool...");
  await pool.end();
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, closing database pool...");
  await pool.end();
});
