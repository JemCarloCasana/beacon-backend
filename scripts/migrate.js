import pg from "pg";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;

function isRenderDatabaseUrl(databaseUrl) {
  return /render\.com|render\.internal/i.test(databaseUrl);
}

function getMigrationPoolConfig(databaseUrl) {
  const config = {
    connectionString: databaseUrl,
  };

  if (isRenderDatabaseUrl(databaseUrl)) {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}

export async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFilePath);
  const migrationsDir = path.resolve(currentDir, "..", "migrations");
  const pool = new Pool(getMigrationPoolConfig(databaseUrl));
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
    const migrationFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    const appliedResult = await client.query("SELECT filename FROM schema_migrations");
    const appliedMigrations = new Set(appliedResult.rows.map((row) => row.filename));

    for (const filename of migrationFiles) {
      if (appliedMigrations.has(filename)) {
        continue;
      }

      const migrationPath = path.join(migrationsDir, filename);
      const sql = await fs.readFile(migrationPath, "utf8");

      try {
        console.log(`Applying migration: ${filename}`);
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [filename]
        );
        await client.query("COMMIT");
        console.log(`Applied migration: ${filename}`);
      } catch (error) {
        await client.query("ROLLBACK");
        error.message = `Migration failed for ${filename}: ${error.message}`;
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}
