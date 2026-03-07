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
import adminMeRoutes from "./src/routes/adminMeRoutes.js";
import adminAdminsRoutes from "./src/routes/adminAdminsRoutes.js";
import incidentRoutes from "./src/routes/incidentRoutes.js";
import broadcastRoutes from "./src/routes/broadcastRoutes.js";
import adminBroadcastRoutes from "./src/routes/adminBroadcastRoutes.js";
import adminSosRoutes from "./src/routes/adminSosRoutes.js";
import adminReportsRoutes from "./src/routes/adminReportsRoutes.js";
import { pool } from "./src/db.js";
import { createRateLimiter } from "./src/middleware/rateLimit.js";
import { getAuthMetricsSnapshot } from "./src/utils/authMetrics.js";
import { getSosStreamMetrics } from "./src/services/sosLiveOps.js";

const app = express();

function parseAllowedOrigins() {
  const configured = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (process.env.ADMIN_FRONTEND_URL) {
    configured.push(process.env.ADMIN_FRONTEND_URL.trim());
  }

  return [...new Set(configured)];
}

const allowedOrigins = parseAllowedOrigins();
const authRateLimit = createRateLimiter({
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 15),
  keyPrefix: "auth_sensitive",
  message: "Too many auth attempts. Please retry shortly."
});

const incidentRateLimit = createRateLimiter({
  windowMs: Number(process.env.ACTION_RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.ACTION_RATE_LIMIT_MAX || 30),
  keyPrefix: "incident_sensitive",
  message: "Too many requests for this action. Please retry shortly."
});

// If behind a proxy (Render/Fly/Heroku/Nginx), keeps req.ip/secure correct
app.set("trust proxy", 1);

// Request logger (FIRST)
app.use(morgan("dev"));

// CORS
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma"],
    credentials: true
  })
);

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

app.get("/health/auth-metrics", (req, res) => {
  return res.json({
    ok: true,
    metrics: getAuthMetricsSnapshot(),
    sos: getSosStreamMetrics()
  });
});

// Auth-sensitive rate limits
app.use("/admin/auth/login", authRateLimit);
app.use("/admin/auth/signup", authRateLimit);
app.use("/me/bootstrap", authRateLimit);
app.use("/sos", incidentRateLimit);
app.use("/incidents", incidentRateLimit);

// Routes
app.use(meRoutes);
app.use(deviceRoutes);
app.use(contactRoutes);
app.use(sosRoutes);
app.use(friendRoutes);
app.use(publicUserRoutes);
app.use(adminAuthRoutes);
app.use(adminMeRoutes);
app.use(adminAdminsRoutes);
app.use(incidentRoutes);
app.use(broadcastRoutes);
app.use(adminBroadcastRoutes);
app.use(adminSosRoutes);
app.use(adminReportsRoutes);

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



