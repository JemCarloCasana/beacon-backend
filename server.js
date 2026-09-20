import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import deviceRoutes from "./src/routes/deviceRoutes.js";
import contactRoutes from "./src/routes/contactRoutes.js";
import sosRoutes from "./src/routes/sosRoutes.js";
import friendRoutes from "./src/routes/friendRoutes.js";
import publicUserRoutes from "./src/routes/publicUserRoutes.js";
import meRoutes from "./src/routes/meRoutes.js";
import notificationRoutes from "./src/routes/notificationRoutes.js";
import adminAuthRoutes from "./src/routes/adminAuthRoutes.js";
import adminMeRoutes from "./src/routes/adminMeRoutes.js";
import adminAdminsRoutes from "./src/routes/adminAdminsRoutes.js";
import incidentRoutes from "./src/routes/incidentRoutes.js";
import broadcastRoutes from "./src/routes/broadcastRoutes.js";
import adminBroadcastRoutes from "./src/routes/adminBroadcastRoutes.js";
import adminSosRoutes from "./src/routes/adminSosRoutes.js";
import adminReportsRoutes from "./src/routes/adminReportsRoutes.js";
import { pool } from "./src/db.js";
import { connectMongo, disconnectMongo, isMongoConnected } from "./src/mongo.js";
import { runMigrations } from "./scripts/migrate.js";
import { createRateLimiter } from "./src/middleware/rateLimit.js";
import { getAuthMetricsSnapshot } from "./src/utils/authMetrics.js";
import { getSosStreamMetrics } from "./src/services/sosLiveOps.js";

const app = express();

function parseAllowedOrigins() {
  const configured = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const builtInOrigins = ["https://beacon-admin-five.vercel.app"];

  if (process.env.ADMIN_FRONTEND_URL) {
    configured.push(process.env.ADMIN_FRONTEND_URL.trim());
  }

  return [...new Set([...builtInOrigins, ...configured])];
}

const allowedOrigins = parseAllowedOrigins();
const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.warn("CORS rejected origin:", origin);
    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma"],
  credentials: false,
  optionsSuccessStatus: 204
};
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

const writeRateLimit = createRateLimiter({
  windowMs: Number(process.env.WRITE_RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.WRITE_RATE_LIMIT_MAX || 60),
  keyPrefix: "write_sensitive",
  message: "Too many write requests. Please retry shortly."
});

// If behind a proxy (Render/Fly/Heroku/Nginx), keeps req.ip/secure correct
app.set("trust proxy", 1);

// Security headers (CORP cross-origin: API serves cors-mode fetch clients,
// including authenticated image blob loads, from other origins)
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

// Request logger (FIRST after security headers)
app.use(morgan("dev"));

// CORS
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

// JSON parser
app.use(express.json({ limit: "2mb" }));

// Malformed JSON fails safely with 400 instead of falling through to 500
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError) && err.status === 400) {
    return res.status(400).json({ message: "Invalid JSON body" });
  }
  return next(err);
});

// Health checks
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/health/db", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    console.error("Database health check failed");
    res.status(503).json({ ok: false });
  }
});

app.get("/health/mongo", (req, res) => {
  if (isMongoConnected()) {
    return res.json({ ok: true });
  }
  return res.status(503).json({ ok: false });
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

// Write-route rate limits (Phase 8: notification/broadcast/report writes)
app.use("/admin/broadcasts", writeRateLimit);
app.use("/admin/admin-requests", writeRateLimit);
app.use("/admin/reports/generate", writeRateLimit);
app.use("/notifications", writeRateLimit);
app.use("/admin/notifications", writeRateLimit);

// Routes
app.use(meRoutes);
app.use(notificationRoutes);
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

const PORT = Number(process.env.PORT || 3000);

async function startServer() {
  try {
    await connectMongo();
    console.log("MongoDB connected");
    await runMigrations();

    app.listen(PORT, () => {
      console.log(`API running on http://localhost:${PORT}`);
      (async () => {
        try {
          const dbIdentity = await pool.query(
            "SELECT current_database() AS db_name, current_schema() AS schema_name"
          );
          const row = dbIdentity.rows?.[0] ?? {};
          console.log("Startup diagnostics", {
            port: PORT,
            db_name: row.db_name ?? null,
            schema_name: row.schema_name ?? null,
          });
        } catch (err) {
          console.warn("Startup diagnostics unavailable", err?.message || err);
        }
      })();
    });
  } catch (err) {
    console.error("Fatal startup error:", err);
    process.exit(1);
  }
}

process.once("SIGTERM", async () => {
  try {
    await disconnectMongo();
  } catch {
    // shutdown continues even if Mongo disconnect reports an issue
  }
});

process.once("SIGINT", async () => {
  try {
    await disconnectMongo();
  } catch {
    // shutdown continues even if Mongo disconnect reports an issue
  }
});

startServerIfDirectRun();

function startServerIfDirectRun() {
  const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
  const modulePath = pathToFileURL(invokedPath ?? "").href;
  if (invokedPath && import.meta.url === modulePath) {
    startServer();
  }
}

export { app };



