import dotenv from "dotenv";
dotenv.config();

import pg from "pg";
const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is undefined");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
