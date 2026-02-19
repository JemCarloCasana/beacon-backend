import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";

import deviceRoutes from "./src/routes/deviceRoutes.js";
import contactRoutes from "./src/routes/contactRoutes.js";
import sosRoutes from "./src/routes/sosRoutes.js";
import friendRoutes from "./src/routes/friendRoutes.js";
import publicUserRoutes from "./src/routes/publicUserRoutes.js";
import meRoutes from "./src/routes/meRoutes.js";
import adminAuthRoutes from "./src/routes/adminAuthRoutes.js";

import { pool } from "./src/db.js";

const app = express();

// If behind a proxy (Render/Fly/Heroku/Nginx), keeps req.ip/secure correct
app.set("trust proxy", 1);

// Request logger (FIRST)
app.use(morgan("dev"));

// CORS
app.use(cors());

// JSON parser
app.use(express.json({ limit: "2mb" }));

// Health checks
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/health/db", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    console.error("Database health check failed:", err?.message || err);
    res.status(503).json({ ok: false, error: err?.message || String(err) });
  }
});

// Routes
app.use(meRoutes);
app.use(deviceRoutes);
app.use(contactRoutes);
app.use(sosRoutes);
app.use(friendRoutes);
app.use(publicUserRoutes);
app.use(express.json());
app.use(adminAuthRoutes);

// 404 fallback (optional but useful)
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler (optional but useful)
app.use((err, req, res, next) => {
  console.error("[unhandled error]", err);
  res.status(500).json({ error: "Internal server error" });
});

// Start server
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
