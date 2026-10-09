import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

process.env.WRITE_RATE_LIMIT_WINDOW_MS = "60000";
process.env.WRITE_RATE_LIMIT_MAX = "3";

const { app } = await import("../server.js");
const { AdminRecord, Notification, ReducedBroadcast: Broadcast } = await import("../src/models/Reduced.js");
const { auditLog, redactAuditValue } = await import("../src/utils/auditLog.js");

const JWT_SECRET = process.env.ADMIN_JWT_SECRET;
assert.ok(JWT_SECRET, "ADMIN_JWT_SECRET must be configured for security tests");

let server;
let baseUrl;

test.before(async () => {
  server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function stubMongoAdmin(adminId, permissions, role) {
  const originalFindOne = AdminRecord.findOne;
  AdminRecord.findOne = () => ({ select: (projection) => ({ lean: async () =>
    projection?.permissions ? { permissions } : projection?.role ? { role } : { _id: adminId, status: "active" },
  }) });
  return () => {
    AdminRecord.findOne = originalFindOne;
  };
}

function stubAdminLookup(t, replacement) {
  const originalFindOne = AdminRecord.findOne;
  AdminRecord.findOne = replacement;
  t.after(() => { AdminRecord.findOne = originalFindOne; });
}

function adminToken(adminId, role = "admin", expiresIn = "7d") {
  return jwt.sign({ sub: String(adminId), adminId: String(adminId), role, token_version: 0 }, JWT_SECRET, { expiresIn });
}

test("helmet sets security headers", async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.ok(res.headers.get("x-frame-options"), "x-frame-options present");
  assert.ok(res.headers.get("content-security-policy"), "content-security-policy present");
});

test("malformed JSON fails safely with 400", async () => {
  const res = await fetch(`${baseUrl}/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not-json",
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { message: "Invalid JSON body" });
});

test("protected routes return 401 without a token", async (t) => {
  const paths = ["/admin/broadcasts", "/admin/me", "/admin/sos/live/stream", "/admin/reports/overview"];
  for (const path of paths) {
    const res = await fetch(`${baseUrl}${path}`);
    assert.equal(res.status, 401, `expected 401 for ${path}`);
    t.diagnostic(`401 ok: ${path}`);
  }
});

test("expired admin token returns 401", async () => {
  const expired = jwt.sign(
    { sub: "999999999999999999999999", adminId: "999999999999999999999999", role: "admin", exp: Math.floor(Date.now() / 1000) - 60 },
    JWT_SECRET
  );
  const res = await fetch(`${baseUrl}/admin/me`, {
    headers: { Authorization: `Bearer ${expired}` },
  });
  assert.equal(res.status, 401);
});

test("personnel without manage_broadcasts gets 403 on draft delete", async () => {
  const personnelId = "111111111111111111111111";
  const restoreMongo = stubMongoAdmin(personnelId, ["view_broadcasts"], "personnel");
  const originalFindOneAndDelete = Broadcast.findOneAndDelete;
  Broadcast.findOneAndDelete = () => {
    throw new Error("handler must not run for forbidden personnel");
  };
  try {
    const res = await fetch(`${baseUrl}/admin/broadcasts/555555555555555555555555`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken(personnelId, "personnel")}` },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { message: "Insufficient permissions" });
  } finally {
    restoreMongo();
    Broadcast.findOneAndDelete = originalFindOneAndDelete;
  }
});

test("admin with manage_broadcasts passes the permission gate", async () => {
  const administratorId = "222222222222222222222222";
  const restoreMongo = stubMongoAdmin(administratorId, ["manage_broadcasts", "view_broadcasts"], "admin");
  const originalFindOneAndDelete = Broadcast.findOneAndDelete;
  const originalFindOne = Broadcast.findOne;
  const originalDeleteMany = Notification.deleteMany;
  Broadcast.findOneAndDelete = () => ({ lean: async () => null });
  Broadcast.findOne = () => ({ lean: async () => null });
  Notification.deleteMany = async () => ({ deletedCount: 0 });
  try {
    const res = await fetch(`${baseUrl}/admin/broadcasts/999999999999999999999999`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken(administratorId, "admin")}` },
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { message: "Broadcast not found" });
  } finally {
    restoreMongo();
    Broadcast.findOneAndDelete = originalFindOneAndDelete;
    Broadcast.findOne = originalFindOne;
    Notification.deleteMany = originalDeleteMany;
  }
});

test("write limiter returns 429 after the test-tuned max", async () => {
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${baseUrl}/admin/broadcasts/7/send`, { method: "POST" });
    statuses.push(res.status);
    await res.text().catch(() => {});
  }
  assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
  assert.equal(statuses[3], 429);
  const limited = await fetch(`${baseUrl}/admin/broadcasts/7/send`, { method: "POST" });
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), {
    message: "Too many write requests. Please retry shortly.",
  });
});

test("auditLog emits single-line JSON and redacts sensitive fields", async (t) => {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  auditLog({
    action: "admin.login",
    actor: 9,
    target: "admin@example.com",
    outcome: "invalid_credentials",
    details: { password: "secret", token: "abc", nested: { secret: "s" } },
  });

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.audit.action, "admin.login");
  assert.equal(parsed.audit.actor, 9);
  assert.equal(parsed.audit.outcome, "invalid_credentials");
  assert.equal(parsed.audit.details.password, "[redacted]");
  assert.equal(parsed.audit.details.token, "[redacted]");
  assert.equal(parsed.audit.details.nested.secret, "[redacted]");
  assert.ok(parsed.audit.ts, "timestamp present");
});

test("redactAuditValue truncates deep structures", () => {
  const deep = { a: { b: { c: { d: "x" } } } };
  assert.deepEqual(redactAuditValue(deep), { a: { b: { c: "[truncated]" } } });
  assert.equal(redactAuditValue({ password_hash: "hash" }).password_hash, "[redacted]");
  assert.equal(redactAuditValue({ MONGODB_URI: "x" }).MONGODB_URI, "[redacted]");
});

test("failed admin login emits a sanitized audit line", async (t) => {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  stubAdminLookup(t, () => ({ lean: async () => null }));
  t.after(() => {
    console.log = originalLog;
  });

  const res = await fetch(`${baseUrl}/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nobody@beacon.test", password: "Wrong-Pass-999!" }),
  });
  assert.equal(res.status, 401);

  const auditLines = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter((entry) => entry?.audit?.action === "admin.login");
  assert.equal(auditLines.length, 1);
  assert.equal(auditLines[0].audit.outcome, "invalid_credentials");
  assert.equal(auditLines[0].audit.target, "nobody@beacon.test");
  assert.ok(!/Wrong-Pass/.test(lines.join("\n")), "password never logged");
});
