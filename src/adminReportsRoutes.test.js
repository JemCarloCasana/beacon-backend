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

function createReportsQueryMock({ generatedRows = [], priorityRows } = {}) {
  const state = {
    generatedRows: [...generatedRows],
    inserts: []
  };

  const query = async (sql, params = []) => {
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
        rowCount: (priorityRows ?? [
          { label: "high", value: 2 },
          { label: "medium", value: 3 }
        ]).length,
        rows: priorityRows ?? [
          { label: "high", value: 2 },
          { label: "medium", value: 3 }
        ]
      };
    }

    if (text.includes("AS incidents")) {
      return {
        rowCount: 1,
        rows: [{ bucket_key: "2026-03-01", incidents: 1 }]
      };
    }

    if (text.includes("AS sos")) {
      return {
        rowCount: 1,
        rows: [{ bucket_key: "2026-03-01", sos: 1 }]
      };
    }

    if (text.includes("avg_response_seconds") && text.includes("GROUP BY bucket_key")) {
      return {
        rowCount: 1,
        rows: [
          {
            bucket_key: "2026-03-01",
            avg_response_seconds: 120,
            avg_resolution_seconds: 360
          }
        ]
      };
    }

    if (text.includes("GROUP BY incident_type")) {
      return {
        rowCount: 2,
        rows: [
          { label: "Fire", value: 12 },
          { label: "Medical Emergency", value: 9 }
        ]
      };
    }

    if (text.includes("GROUP BY st.emergency_category")) {
      return {
        rowCount: 2,
        rows: [
          { label: "medical", value: 7 },
          { label: "violence", value: 3 }
        ]
      };
    }

    if (
      text.includes("FROM incident_reports") &&
      text.includes("assigned_department") &&
      text.includes("ORDER BY created_at DESC, id DESC")
    ) {
      return {
        rowCount: 1,
        rows: [
          {
            id: 88,
            incident_type: "fire",
            status: "resolved",
            priority: "high",
            assigned_department: "Fire Station Unit",
            address: "Main Hall",
            created_at: "2026-03-01T00:00:00.000Z",
            dispatched_at: "2026-03-01T00:03:00.000Z",
            resolved_at: "2026-03-01T00:18:00.000Z"
          }
        ]
      };
    }

    if (text.includes("FROM sos_threads st") && text.includes("st.assigned_unit")) {
      return {
        rowCount: 1,
        rows: [
          {
            sos_id: 44,
            latest_status: "resolved",
            emergency_category: "medical",
            assigned_unit: "Emergency Medical Unit",
            terminal_status: "safe",
            address: "Science Building",
            opened_at: "2026-03-01T00:05:00.000Z",
            resolved_at: "2026-03-01T00:20:00.000Z"
          }
        ]
      };
    }

    if (text.includes("INSERT INTO admin_report_runs")) {
      state.inserts.push(params);
      state.generatedRows.push({
        report_key: params[0],
        range_key: params[1],
        generated_at: params[4]
      });
      return { rowCount: 1, rows: [] };
    }

    if (text.includes("FROM admin_report_runs")) {
      return {
        rowCount: state.generatedRows.length,
        rows: state.generatedRows.map((row) => ({ ...row }))
      };
    }

    throw new Error(`Unexpected query in test: ${text}`);
  };

  return { query, state };
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

test("POST /admin/reports/generate accepts combined safety report keys and rejects legacy keys", async (t) => {
  const originalQuery = pool.query;
  const { query, state } = createReportsQueryMock();
  pool.query = query;

  t.after(() => {
    pool.query = originalQuery;
  });

  const acceptedRanges = new Map([
    ["daily_safety_report", "24h"],
    ["weekly_safety_report", "7d"],
    ["monthly_safety_report", "30d"]
  ]);
  const stack = getRoute("/admin/reports/generate", "post");
  const handler = stack[stack.length - 1].handle;

  for (const [reportKey, expectedRange] of acceptedRanges.entries()) {
    const req = {
      body: { report_key: reportKey, timezone: "Asia/Manila" },
      admin: { adminId: 9 }
    };
    const res = createRes();

    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.range, expectedRange);
    assert.equal(res.body.cards.length, 3);
    assert.equal(res.body.cards.some((card) => card.report_key === reportKey), true);
  }

  const rejectedReq = {
    body: { report_key: "daily_sos_summary", timezone: "Asia/Manila" },
    admin: { adminId: 9 }
  };
  const rejectedRes = createRes();
  await handler(rejectedReq, rejectedRes);

  assert.equal(rejectedRes.statusCode, 400);
  assert.deepEqual(rejectedRes.body, { message: "Invalid report_key" });
  assert.equal(state.inserts.length, 3);
  assert.deepEqual(
    state.inserts.map((params) => [params[0], params[1], params[2], params[3]]),
    [
      ["daily_safety_report", "24h", "Asia/Manila", 9],
      ["weekly_safety_report", "7d", "Asia/Manila", 9],
      ["monthly_safety_report", "30d", "Asia/Manila", 9]
    ]
  );
});

test("GET /admin/reports/overview returns analytics payload with exactly three combined cards", async (t) => {
  const originalQuery = pool.query;
  const { query } = createReportsQueryMock({
    generatedRows: [
      {
        report_key: "daily_safety_report",
        range_key: "24h",
        generated_at: "2026-03-01T10:00:00.000Z"
      },
      {
        report_key: "weekly_safety_report",
        range_key: "7d",
        generated_at: "2026-03-02T10:00:00.000Z"
      },
      {
        report_key: "monthly_safety_report",
        range_key: "30d",
        generated_at: "2026-03-03T10:00:00.000Z"
      }
    ]
  });
  pool.query = query;

  t.after(() => {
    pool.query = originalQuery;
  });

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
  assert.deepEqual(
    res.body.cards.map((card) => card.report_key),
    ["daily_safety_report", "weekly_safety_report", "monthly_safety_report"]
  );
  assert.deepEqual(
    res.body.cards.map((card) => card.title),
    ["Daily Safety Report", "Weekly Safety Report", "Monthly Safety Report"]
  );
  assert.deepEqual(
    res.body.cards.map((card) => card.description),
    [
      "Combined incident and SOS overview for the last 24 hours",
      "Combined incident and SOS overview for the last 7 days",
      "Combined incident and SOS overview for the last 30 days"
    ]
  );
  assert.equal(res.body.cards[1].last_generated_at, "2026-03-02T10:00:00.000Z");
  assert.equal(res.body.kpis.total_incidents, 5);
  assert.equal(res.body.kpis.active_sos, 4);
  assert.deepEqual(res.body.charts.incidents_by_priority, [
    { label: "low", value: 0 },
    { label: "medium", value: 3 },
    { label: "high", value: 2 },
    { label: "critical", value: 0 }
  ]);
  assert.equal(Array.isArray(res.body.charts.incidents_trend), true);
  assert.equal(Array.isArray(res.body.charts.response_time_trend), true);
  assert.deepEqual(res.body.charts.incident_categories_frequency, [
    { label: "Fire", value: 12 },
    { label: "Medical Emergency", value: 9 }
  ]);
  assert.deepEqual(res.body.charts.sos_categories_frequency, [
    { label: "Medical", value: 7 },
    { label: "Violence", value: 3 }
  ]);
});

test("GET /admin/reports/overview normalizes mixed-case priorities and excludes blank buckets", async (t) => {
  const originalQuery = pool.query;
  const { query } = createReportsQueryMock({
    priorityRows: [
      { label: "HIGH", value: 2 },
      { label: "Medium", value: 3 },
      { label: "", value: 9 },
      { label: null, value: 4 },
      { label: "urgent", value: 7 }
    ]
  });
  pool.query = query;

  t.after(() => {
    pool.query = originalQuery;
  });

  const handler = getRoute("/admin/reports/overview", "get").at(-1).handle;
  const req = { query: { range: "7d", timezone: "Asia/Manila" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.charts.incidents_by_priority, [
    { label: "low", value: 0 },
    { label: "medium", value: 3 },
    { label: "high", value: 2 },
    { label: "critical", value: 0 }
  ]);
});

test("GET /admin/reports/overview returns all zero priority buckets for empty ranges", async (t) => {
  const originalQuery = pool.query;
  const { query } = createReportsQueryMock({ priorityRows: [] });
  pool.query = query;

  t.after(() => {
    pool.query = originalQuery;
  });

  const handler = getRoute("/admin/reports/overview", "get").at(-1).handle;
  const req = { query: { range: "30d", timezone: "Asia/Manila" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.charts.incidents_by_priority, [
    { label: "low", value: 0 },
    { label: "medium", value: 0 },
    { label: "high", value: 0 },
    { label: "critical", value: 0 }
  ]);
});

test("GET /admin/reports/export.csv returns combined CSV for 24h, 7d, and 30d", async (t) => {
  const originalQuery = pool.query;
  const { query } = createReportsQueryMock();
  pool.query = query;

  t.after(() => {
    pool.query = originalQuery;
  });

  const stack = getRoute("/admin/reports/export.csv", "get");
  const handler = stack[stack.length - 1].handle;

  for (const range of ["24h", "7d", "30d"]) {
    const req = { query: { range, timezone: "Asia/Manila" } };
    const res = createRes();

    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "text/csv; charset=utf-8");
    assert.match(res.headers["content-disposition"], new RegExp(`attachment; filename=\"beacon-report-${range}-`));
    assert.equal(typeof res.body, "string");
    assert.match(res.body, /Metadata/);
    assert.match(res.body, /KPIs/);
    assert.match(res.body, /Incident Category Frequency/);
    assert.match(res.body, /SOS Category Frequency/);
    assert.match(res.body, /Trend Rows/);
    assert.match(res.body, /Incident Details/);
    assert.match(res.body, /SOS Details/);
    assert.match(res.body, /incident_id,incident_type,status,priority,assigned_department,address,created_at,dispatched_at,resolved_at/);
    assert.match(res.body, /sos_id,latest_status,emergency_category,assigned_unit,terminal_status,address,opened_at,resolved_at/);
  }
});

test("weekly generate plus 7d export keeps overview last_generated_at in sync", async (t) => {
  const originalQuery = pool.query;
  const { query } = createReportsQueryMock({
    generatedRows: [
      {
        report_key: "daily_safety_report",
        range_key: "24h",
        generated_at: "2026-03-01T09:00:00.000Z"
      },
      {
        report_key: "monthly_safety_report",
        range_key: "30d",
        generated_at: "2026-03-01T11:00:00.000Z"
      }
    ]
  });
  pool.query = query;

  t.after(() => {
    pool.query = originalQuery;
  });

  const generateHandler = getRoute("/admin/reports/generate", "post").at(-1).handle;
  const overviewHandler = getRoute("/admin/reports/overview", "get").at(-1).handle;
  const exportHandler = getRoute("/admin/reports/export.csv", "get").at(-1).handle;

  const generateRes = createRes();
  await generateHandler(
    {
      body: { report_key: "weekly_safety_report", timezone: "Asia/Manila" },
      admin: { adminId: 7 }
    },
    generateRes
  );

  assert.equal(generateRes.statusCode, 200);
  const weeklyCard = generateRes.body.cards.find((card) => card.report_key === "weekly_safety_report");
  assert.ok(weeklyCard?.last_generated_at);

  const exportRes = createRes();
  await exportHandler({ query: { range: "7d", timezone: "Asia/Manila" } }, exportRes);
  assert.equal(exportRes.statusCode, 200);
  assert.match(exportRes.body, /Incident Details/);
  assert.match(exportRes.body, /SOS Details/);

  const overviewRes = createRes();
  await overviewHandler({ query: { range: "7d", timezone: "Asia/Manila" } }, overviewRes);
  assert.equal(overviewRes.statusCode, 200);
  assert.equal(
    overviewRes.body.cards.find((card) => card.report_key === "weekly_safety_report")?.last_generated_at,
    weeklyCard.last_generated_at
  );
});
