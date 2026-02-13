import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import { pool } from "./src/db.js";
import meRoutes from "./src/routes/meRoutes.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/health/db", async (req, res) => {
  const r = await pool.query("SELECT 1 AS ok");
  res.json({ db: r.rows[0].ok === 1 });
});

app.use(meRoutes);

app.listen(process.env.PORT || 3000, () =>
  console.log(`API running on http://localhost:${process.env.PORT || 3000}`)
);
