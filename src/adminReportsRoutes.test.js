import test from "node:test";
import assert from "node:assert/strict";

import router from "./routes/adminReportsRoutes.js";
import { pool } from "./db.js";

function getRoute(path, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods?.[method]
  );
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }
  return layer.route.stack;
}

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    }
  };
}

test("GET /admin/reports/overview uses admin auth middleware without extra permission guard", () => {
  const stack = getRoute("/admin/reports/overview", "get");
  assert.equal(stack.length, 2);
});

test("GET /admin/reports/overview returns 400 on invalid range", async () => {
  const stack = getRoute("/admin/reports/overview", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { query: { range: "2d", timezone: "Asia/Manila" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid range" });
});

test("GET /admin/reports/overview returns 400 on invalid timezone", async () => {
  const stack = getRoute("/admin/reports/overview", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { query: { range: "24h", timezone: "UTC" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid timezone" });
});

test("POST /admin/reports/generate returns 400 on invalid report key", async () => {
  const stack = getRoute("/admin/reports/generate", "post");
  const handler = stack[stack.length - 1].handle;
  const req = { body: { report_key: "daily", timezone: "Asia/Manila" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid report_key" });
});

test("GET /admin/reports/overview returns analytics payload with cards", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql) => {
    const text = String(sql);

    if (text.includes("COUNT(*)::int AS total_incidents")) {
      return {
        rowCount: 1,
        rows: [
          {
            total_incidents: 5,
            active_incidents: 3,
            resolved_incidents: 2,
            avg_response_seconds: 120,
            avg_resolution_seconds: 360
          }
        ]
      };
    }

    if (text.includes("COUNT(*)::int AS active_sos")) {
      return { rowCount: 1, rows: [{ active_sos: 4 }] };
    }

    if (text.includes("FROM incident_reports") && text.includes("GROUP BY status")) {
      return {
        rowCount: 2,
        rows: [
          { label: "pending", value: 2 },
          { label: "resolved", value: 3 }
        ]
      };
    }

    if (text.includes("FROM incident_reports") && text.includes("GROUP BY priority")) {
      return {
        rowCount: 2,
        rows: [
          { label: "high", value: 2 },
          { label: "medium", value: 3 }
        ]
      };
    }

    if (text.includes("AS incidents")) {
      return {
        rowCount: 1,
        rows: [{ bucket_key: "2026-03-01 09:00", incidents: 1 }]
      };
    }

    if (text.includes("AS sos")) {
      return {
        rowCount: 1,
        rows: [{ bucket_key: "2026-03-01 09:00", sos: 1 }]
      };
    }

    if (text.includes("avg_response_seconds") && text.includes("GROUP BY bucket_key")) {
      return {
        rowCount: 1,
        rows: [
          {
            bucket_key: "2026-03-01 09:00",
            avg_response_seconds: 120,
            avg_resolution_seconds: 360
          }
        ]
      };
    }

    if (text.includes("FROM admin_report_runs")) {
      return {
        rowCount: 1,
        rows: [
          {
            report_key: "daily_incident_summary",
            range_key: "24h",
            generated_at: "2026-03-01T10:00:00.000Z"
          }
        ]
      };
    }

    throw new Error(`Unexpected query in test: ${text}`);
  };

  const stack = getRoute("/admin/reports/overview", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { query: { range: "24h", timezone: "Asia/Manila" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.range, "24h");
  assert.equal(res.body.timezone, "Asia/Manila");
  assert.equal(Array.isArray(res.body.cards), true);
  assert.equal(res.body.cards.length, 3);
  assert.equal(res.body.kpis.total_incidents, 5);
  assert.equal(res.body.kpis.active_sos, 4);
  assert.equal(Array.isArray(res.body.charts.incidents_trend), true);
  assert.equal(Array.isArray(res.body.charts.response_time_trend), true);
});

test("GET /admin/reports/export.csv returns CSV with download headers", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql) => {
    const text = String(sql);

    if (text.includes("COUNT(*)::int AS total_incidents")) {
      return {
        rowCount: 1,
        rows: [
          {
            total_incidents: 1,
            active_incidents: 1,
            resolved_incidents: 0,
            avg_response_seconds: 0,
            avg_resolution_seconds: 0
          }
        ]
      };
    }

    if (text.includes("COUNT(*)::int AS active_sos")) {
      return { rowCount: 1, rows: [{ active_sos: 1 }] };
    }

    if (text.includes("GROUP BY status")) {
      return { rowCount: 1, rows: [{ label: "pending", value: 1 }] };
    }

    if (text.includes("GROUP BY priority")) {
      return { rowCount: 1, rows: [{ label: "high", value: 1 }] };
    }

    if (text.includes("AS incidents")) {
      return { rowCount: 1, rows: [{ bucket_key: "2026-03-01", incidents: 1 }] };
    }

    if (text.includes("AS sos")) {
      return { rowCount: 1, rows: [{ bucket_key: "2026-03-01", sos: 1 }] };
    }

    if (text.includes("GROUP BY bucket_key")) {
      return {
        rowCount: 1,
        rows: [{ bucket_key: "2026-03-01", avg_response_seconds: 0, avg_resolution_seconds: 0 }]
      };
    }

    throw new Error(`Unexpected query in test: ${text}`);
  };

  const stack = getRoute("/admin/reports/export.csv", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { query: { range: "7d", timezone: "Asia/Manila" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "text/csv; charset=utf-8");
  assert.match(res.headers["content-disposition"], /attachment; filename="beacon-report-7d-/);
  assert.equal(typeof res.body, "string");
  assert.match(res.body, /Metadata/);
  assert.match(res.body, /KPIs/);
  assert.match(res.body, /Trend Rows/);
});
