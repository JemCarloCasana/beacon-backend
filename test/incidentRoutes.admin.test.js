import test from "node:test";
import assert from "node:assert/strict";

import router from "../src/routes/incidentRoutes.js";
import { pool } from "../src/db.js";

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

test("GET /admin/incidents route no longer includes incident read permission guard", async () => {
  const stack = getRoute("/admin/incidents", "get");
  assert.equal(stack.length, 2);
});

test("GET /admin/incidents returns mapped DTO rows with filter + pagination", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let capturedSql = "";
  let capturedParams = [];
  pool.query = async (sql, params) => {
    capturedSql = sql;
    capturedParams = params;
    return {
      rowCount: 1,
      rows: [
        {
          id: 9,
          user_id: 21,
          incident_type: "legacy_type",
          assigned_department: "Police Personnel",
          description: "Power outage",
          latitude: null,
          longitude: null,
          address: null,
          priority: "high",
          status: "in_progress",
          created_at: "2026-03-01T00:00:00.000Z",
          updated_at: "2026-03-01T00:05:00.000Z",
          dispatched_at: "2026-03-01T00:03:00.000Z",
          resolved_at: null,
          resolution_notes: null,
          images: [{ id: 44, sort_order: 0 }]
        }
      ]
    };
  };

  const stack = getRoute("/admin/incidents", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { query: { status: "in_progress", page: "2", limit: "10" } };
  const res = createRes();

  await handler(req, res);

  assert.match(capturedSql, /FROM incident_reports/i);
  assert.deepEqual(capturedParams, ["in_progress", 10, 10]);
  assert.equal(res.statusCode, 200);
  assert.equal(Array.isArray(res.body), true);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, 9);
  assert.equal(res.body[0].incident_type, "legacy_type");
  assert.equal(res.body[0].assigned_department, "Police Personnel");
  assert.equal(res.body[0].created_at, "2026-03-01T00:00:00.000Z");
  assert.equal(res.body[0].updated_at, "2026-03-01T00:05:00.000Z");
  assert.equal(res.body[0].dispatched_at, "2026-03-01T00:03:00.000Z");
  assert.equal(res.body[0].resolved_at, null);
  assert.equal(res.body[0].resolution_notes, null);
  assert.equal(res.body[0].createdAt, undefined);
  assert.equal(res.body[0].updatedAt, undefined);
  assert.equal(res.body[0].dispatchedAt, undefined);
  assert.equal(res.body[0].resolvedAt, undefined);
  assert.equal(res.body[0].resolutionNotes, undefined);
  assert.equal(res.body[0].category, undefined);
  assert.equal(res.body[0].assignedAdminId, undefined);
  assert.equal(res.body[0].title, "Incident #9");
  assert.equal(res.body[0].image_url, "/admin/incidents/9/images/44");
  assert.deepEqual(res.body[0].images, ["/admin/incidents/9/images/44"]);
  assert.deepEqual(res.body[0].location, {
    latitude: null,
    longitude: null,
    address: null
  });
});

test("GET /admin/incidents/:id returns 404 when record is missing", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 0,
    rows: []
  });

  const stack = getRoute("/admin/incidents/:id", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { params: { id: "999" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: "Incident not found" });
});

test("GET /admin/incidents/:id returns canonical incident payload", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 1,
    rows: [
      {
        id: 12,
        user_id: 1,
        incident_type: "fire",
        assigned_department: "Fire Station Unit",
        description: "Warehouse smoke",
        latitude: 15.1,
        longitude: 120.1,
        address: "Main Road",
        priority: "critical",
        status: "dispatched",
        created_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-01T00:05:00.000Z",
        dispatched_at: "2026-03-01T00:03:00.000Z",
        resolved_at: null,
        resolution_notes: null,
        images: [{ id: 9, sort_order: 0 }, { id: 10, sort_order: 1 }]
      }
    ]
  });

  const stack = getRoute("/admin/incidents/:id", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { params: { id: "12" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.incident_type, "fire");
  assert.equal(res.body.assigned_department, "Fire Station Unit");
  assert.equal(res.body.created_at, "2026-03-01T00:00:00.000Z");
  assert.equal(res.body.updated_at, "2026-03-01T00:05:00.000Z");
  assert.equal(res.body.dispatched_at, "2026-03-01T00:03:00.000Z");
  assert.equal(res.body.resolved_at, null);
  assert.equal(res.body.resolution_notes, null);
  assert.equal(res.body.createdAt, undefined);
  assert.equal(res.body.updatedAt, undefined);
  assert.equal(res.body.dispatchedAt, undefined);
  assert.equal(res.body.resolvedAt, undefined);
  assert.equal(res.body.resolutionNotes, undefined);
  assert.equal(res.body.category, undefined);
  assert.equal(res.body.assignedAdminId, undefined);
  assert.equal(res.body.image_url, "/admin/incidents/12/images/9");
  assert.deepEqual(res.body.images, ["/admin/incidents/12/images/9", "/admin/incidents/12/images/10"]);
});

test("GET /admin/incidents/:incidentId/images/:imageId returns image bytes", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  pool.query = async () => ({
    rowCount: 1,
    rows: [{ image_data: imageBuffer, content_type: "image/png" }]
  });

  const stack = getRoute("/admin/incidents/:incidentId/images/:imageId", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { params: { incidentId: "5", imageId: "2" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/png");
  assert.equal(Buffer.isBuffer(res.body), true);
  assert.equal(res.body.equals(imageBuffer), true);
});

test("GET /admin/incidents/:incidentId/images/:imageId returns 400 for invalid params", async () => {
  const stack = getRoute("/admin/incidents/:incidentId/images/:imageId", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { params: { incidentId: "bad", imageId: "2" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid incident/image id" });
});

test("GET /admin/incidents/:incidentId/images/:imageId returns 404 when image is missing", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 0,
    rows: []
  });

  const stack = getRoute("/admin/incidents/:incidentId/images/:imageId", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { params: { incidentId: "5", imageId: "999" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: "Image not found" });
});

test("PATCH /admin/incidents/:id returns 409 on invalid status transition", async (t) => {
  const originalConnect = pool.connect;
  t.after(() => {
    pool.connect = originalConnect;
  });

  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });

      if (/^BEGIN$/i.test(String(sql).trim())) {
        return { rowCount: null, rows: [] };
      }
      if (/FROM incident_reports/i.test(sql) && /WHERE id = \$1/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ id: 7, status: "pending", dispatched_at: null, resolved_at: null }]
        };
      }
      if (/^ROLLBACK$/i.test(String(sql).trim())) {
        return { rowCount: null, rows: [] };
      }
      throw new Error(`Unexpected query in test: ${sql}`);
    },
    release() {}
  };

  pool.connect = async () => client;

  const stack = getRoute("/admin/incidents/:id", "patch");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { id: "7" },
    body: { status: "resolved" }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { message: "Invalid status transition" });
  assert.equal(queries.some((entry) => /^ROLLBACK$/i.test(String(entry.sql).trim())), true);
});

test("PATCH /admin/incidents/:id route no longer includes manage_incidents permission guard", async () => {
  const stack = getRoute("/admin/incidents/:id", "patch");
  assert.equal(stack.length, 2);
});

test("PATCH /admin/incidents/:id rejects legacy assigned admin keys", async (t) => {
  const originalConnect = pool.connect;
  t.after(() => {
    pool.connect = originalConnect;
  });

  pool.connect = async () => ({
    async query() {
      throw new Error("Unexpected DB query");
    },
    release() {}
  });

  const stack = getRoute("/admin/incidents/:id", "patch");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { id: "7" },
    body: { assignedAdminId: 2 }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    message: "assigned_admin_id is no longer supported; use assigned_department"
  });
});

test("PATCH /admin/incidents/:id rejects invalid assigned_department", async (t) => {
  const originalConnect = pool.connect;
  t.after(() => {
    pool.connect = originalConnect;
  });

  pool.connect = async () => ({
    async query() {
      throw new Error("Unexpected DB query");
    },
    release() {}
  });

  const stack = getRoute("/admin/incidents/:id", "patch");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { id: "7" },
    body: { assigned_department: "Invalid Unit" }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid assigned_department" });
});

test("PATCH /admin/incidents/:id accepts assigned_department and returns canonical payload", async (t) => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  t.after(() => {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  });

  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });

      if (/^BEGIN$/i.test(String(sql).trim())) {
        return { rowCount: null, rows: [] };
      }
      if (/FROM incident_reports/i.test(String(sql)) && /WHERE id = \$1/i.test(String(sql))) {
        return {
          rowCount: 1,
          rows: [{ id: 7, status: "pending", dispatched_at: null, resolved_at: null }]
        };
      }
      if (/UPDATE incident_reports/i.test(String(sql))) {
        return { rowCount: 1, rows: [{ id: 7 }] };
      }
      if (/^COMMIT$/i.test(String(sql).trim())) {
        return { rowCount: null, rows: [] };
      }
      throw new Error(`Unexpected query in test: ${sql}`);
    },
    release() {}
  };

  pool.connect = async () => client;
  pool.query = async () => ({
    rowCount: 1,
    rows: [
      {
        id: 7,
        user_id: 4,
        incident_type: "fire",
        assigned_department: "Fire Station Unit",
        description: "Fire alert",
        latitude: null,
        longitude: null,
        address: null,
        priority: "high",
        status: "dispatched",
        created_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-01T00:05:00.000Z",
        dispatched_at: "2026-03-01T00:03:00.000Z",
        resolved_at: null,
        resolution_notes: null,
        images: []
      }
    ]
  });

  const stack = getRoute("/admin/incidents/:id", "patch");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { id: "7" },
    body: { status: "dispatched", assigned_department: "Fire Station Unit" }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.incident_type, "fire");
  assert.equal(res.body.assigned_department, "Fire Station Unit");
  assert.equal(res.body.created_at, "2026-03-01T00:00:00.000Z");
  assert.equal(res.body.updated_at, "2026-03-01T00:05:00.000Z");
  assert.equal(res.body.dispatched_at, "2026-03-01T00:03:00.000Z");
  assert.equal(res.body.resolved_at, null);
  assert.equal(res.body.resolution_notes, null);
  assert.equal(res.body.createdAt, undefined);
  assert.equal(res.body.updatedAt, undefined);
  assert.equal(res.body.dispatchedAt, undefined);
  assert.equal(res.body.resolvedAt, undefined);
  assert.equal(res.body.resolutionNotes, undefined);
  assert.equal(res.body.image_url, null);
  assert.equal(res.body.assignedAdminId, undefined);
  assert.equal(res.body.category, undefined);
  assert.notEqual(res.body.updated_at, res.body.created_at);
  assert.equal(
    queries.some(
      (entry) =>
        /UPDATE incident_reports/i.test(entry.sql) &&
        /assigned_department = \$\d+/i.test(entry.sql) &&
        /updated_at = NOW\(\)/i.test(entry.sql)
    ),
    true
  );
});

test("PATCH /admin/incidents/:id accepts assignedDepartment alias", async (t) => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  t.after(() => {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  });

  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });

      if (/^BEGIN$/i.test(String(sql).trim())) {
        return { rowCount: null, rows: [] };
      }
      if (/FROM incident_reports/i.test(String(sql)) && /WHERE id = \$1/i.test(String(sql))) {
        return {
          rowCount: 1,
          rows: [{ id: 8, status: "pending", dispatched_at: null, resolved_at: null }]
        };
      }
      if (/UPDATE incident_reports/i.test(String(sql))) {
        return { rowCount: 1, rows: [{ id: 8 }] };
      }
      if (/^COMMIT$/i.test(String(sql).trim())) {
        return { rowCount: null, rows: [] };
      }
      throw new Error(`Unexpected query in test: ${sql}`);
    },
    release() {}
  };

  pool.connect = async () => client;
  pool.query = async () => ({
    rowCount: 1,
    rows: [
      {
        id: 8,
        user_id: 4,
        incident_type: "medical",
        assigned_department: "Emergency Medical Unit",
        description: "Medical request",
        latitude: null,
        longitude: null,
        address: null,
        priority: "high",
        status: "pending",
        created_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-01T00:05:00.000Z",
        dispatched_at: null,
        resolved_at: null,
        resolution_notes: null,
        images: []
      }
    ]
  });

  const stack = getRoute("/admin/incidents/:id", "patch");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { id: "8" },
    body: { assignedDepartment: "Emergency Medical Unit" }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.assigned_department, "Emergency Medical Unit");
  assert.equal(res.body.created_at, "2026-03-01T00:00:00.000Z");
  assert.equal(res.body.updated_at, "2026-03-01T00:05:00.000Z");
  assert.equal(res.body.dispatched_at, null);
  assert.equal(res.body.resolved_at, null);
  assert.equal(res.body.resolution_notes, null);
  assert.equal(res.body.createdAt, undefined);
  assert.equal(res.body.updatedAt, undefined);
  assert.equal(res.body.dispatchedAt, undefined);
  assert.equal(res.body.resolvedAt, undefined);
  assert.equal(res.body.resolutionNotes, undefined);
  assert.equal(res.body.image_url, null);
  assert.equal(
    queries.some(
      (entry) =>
        /UPDATE incident_reports/i.test(entry.sql) && /assigned_department = \$\d+/i.test(entry.sql)
    ),
    true
  );
});

test("PATCH /admin/incidents/:id includes resolution_notes when status is resolved", async (t) => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  t.after(() => {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  });

  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });

      if (/^BEGIN$/i.test(String(sql).trim())) {
        return { rowCount: null, rows: [] };
      }
      if (/FROM incident_reports/i.test(String(sql)) && /WHERE id = \$1/i.test(String(sql))) {
        return {
          rowCount: 1,
          rows: [{ id: 11, status: "in_progress", dispatched_at: "2026-03-01T00:03:00.000Z", resolved_at: null }]
        };
      }
      if (/UPDATE incident_reports/i.test(String(sql))) {
        return { rowCount: 1, rows: [{ id: 11 }] };
      }
      if (/^COMMIT$/i.test(String(sql).trim())) {
        return { rowCount: null, rows: [] };
      }
      throw new Error(`Unexpected query in test: ${sql}`);
    },
    release() {}
  };

  pool.connect = async () => client;
  pool.query = async () => ({
    rowCount: 1,
    rows: [
      {
        id: 11,
        user_id: 4,
        incident_type: "medical",
        assigned_department: "Emergency Medical Unit",
        description: "Resolved medical response",
        latitude: null,
        longitude: null,
        address: null,
        priority: "high",
        status: "resolved",
        created_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-01T00:18:00.000Z",
        dispatched_at: "2026-03-01T00:03:00.000Z",
        resolved_at: "2026-03-01T00:18:00.000Z",
        resolution_notes: "Patient transported and scene cleared.",
        images: []
      }
    ]
  });

  const stack = getRoute("/admin/incidents/:id", "patch");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { id: "11" },
    body: { status: "resolved", resolutionNotes: "Patient transported and scene cleared." }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "resolved");
  assert.equal(res.body.resolution_notes, "Patient transported and scene cleared.");
  assert.equal(res.body.resolved_at, "2026-03-01T00:18:00.000Z");
  assert.equal(res.body.updated_at, "2026-03-01T00:18:00.000Z");
  assert.equal(res.body.resolutionNotes, undefined);
  assert.equal(
    queries.some(
      (entry) =>
        /UPDATE incident_reports/i.test(entry.sql) &&
        /resolved_at = NOW\(\)/i.test(entry.sql) &&
        /updated_at = NOW\(\)/i.test(entry.sql)
    ),
    true
  );
});
