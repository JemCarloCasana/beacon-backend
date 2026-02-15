import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import deviceRoutes from "./src/routes/deviceRoutes.js";
import contactRoutes from "./src/routes/contactRoutes.js";



import { pool } from "./src/db.js";
import meRoutes from "./src/routes/meRoutes.js";

dotenv.config();

const app = express();

// Request logger (FIRST)
app.use(morgan("dev"));

//  CORS
app.use(cors());

//  JSON parser
app.use(express.json({ limit: "2mb" }));

// Health checks
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/health/db", async (req, res) => {
  const r = await pool.query("SELECT 1 AS ok");
  res.json({ db: r.rows[0].ok === 1 });
});

//  Routes
app.use(meRoutes);

// Device
app.use(deviceRoutes);

// Contact
app.use(contactRoutes);


// Start server
app.listen(process.env.PORT || 3000, () =>
  console.log(`API running on http://localhost:${process.env.PORT || 3000}`)
);
