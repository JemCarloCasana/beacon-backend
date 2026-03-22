import test from "node:test";
import assert from "node:assert/strict";

import router from "./routes/meRoutes.js";
import { pool } from "./db.js";
import { requireAppAuth } from "./middleware/requireAppAuth.js";

function findRouteHandler(path, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods?.[method]
  );
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const bootstrapHandler = findRouteHandler("/me/bootstrap", "post");
const getMeHandler = findRouteHandler("/me", "get");
const getUsersHandler = findRouteHandler("/users", "get");
const searchUsersHandler = findRouteHandler("/users/search", "get");

function createBootstrapClient({
  existingBeaconCode = null,
  insertRoleRecorder = null,
} = {}) {
  return {
    released: false,
    async query(text, values = []) {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("SELECT id, beacon_code")) {
        if (existingBeaconCode) {
          return { rowCount: 1, rows: [{ id: 1, beacon_code: existingBeaconCode }] };
        }
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("SELECT 1 FROM users WHERE beacon_code = $1")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("INSERT INTO users")) {
        if (insertRoleRecorder) {
          insertRoleRecorder(values[4]);
        }
        return {
          rowCount: 1,
          rows: [
            {
              id: 77,
              firebase_uid: values[0],
              email: values[1],
              full_name: values[2],
              phone_number: values[3],
              role: values[4],
              profile_image_url: null,
              beacon_code: values[5],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL in test: ${text}`);
    },
    release() {
      this.released = true;
    },
  };
}

test("POST /me/bootstrap accepts citizen and normalizes mixed-case role", async (t) => {
  const originalConnect = pool.connect;
  let receivedRole = null;
  const client = createBootstrapClient({
    insertRoleRecorder: (role) => {
      receivedRole = role;
    },
  });
  pool.connect = async () => client;
  t.after(() => {
    pool.connect = originalConnect;
  });

  const req = {
    auth: { uid: "uid-citizen", email: "citizen@example.com" },
    body: { full_name: "Citizen User", phone_number: "09123456789", role: "CiTiZen" },
  };
  const res = createRes();

  await bootstrapHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(receivedRole, "citizen");
  assert.equal(res.body.role, "citizen");
  assert.equal(client.released, true);
});

test("POST /me/bootstrap accepts student role", async (t) => {
  const originalConnect = pool.connect;
  const client = createBootstrapClient();
  pool.connect = async () => client;
  t.after(() => {
    pool.connect = originalConnect;
  });

  const req = {
    auth: { uid: "uid-student", email: "student@example.com" },
    body: { full_name: "Student User", role: "student" },
  };
  const res = createRes();

  await bootstrapHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.role, "student");
  assert.equal(client.released, true);
});

test("POST /me/bootstrap rejects missing role", async (t) => {
  const originalConnect = pool.connect;
  const client = createBootstrapClient();
  pool.connect = async () => client;
  t.after(() => {
    pool.connect = originalConnect;
  });

  const req = {
    auth: { uid: "uid-missing-role", email: "missing-role@example.com" },
    body: { full_name: "Missing Role" },
  };
  const res = createRes();

  await bootstrapHandler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid role" });
  assert.equal(client.released, true);
});

test("POST /me/bootstrap rejects unknown role", async (t) => {
  const originalConnect = pool.connect;
  const client = createBootstrapClient();
  pool.connect = async () => client;
  t.after(() => {
    pool.connect = originalConnect;
  });

  const req = {
    auth: { uid: "uid-unknown-role", email: "unknown-role@example.com" },
    body: { full_name: "Unknown Role", role: "teacher" },
  };
  const res = createRes();

  await bootstrapHandler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid role" });
  assert.equal(client.released, true);
});

test("POST /me/bootstrap updates role to latest submitted value on re-bootstrap", async (t) => {
  const originalConnect = pool.connect;
  const insertedRoles = [];
  pool.connect = async () =>
    createBootstrapClient({
      existingBeaconCode: "BCN-ABC123",
      insertRoleRecorder: (role) => insertedRoles.push(role),
    });
  t.after(() => {
    pool.connect = originalConnect;
  });

  const firstRes = createRes();
  await bootstrapHandler(
    {
      auth: { uid: "uid-rebootstrap", email: "rebootstrap@example.com" },
      body: { full_name: "Rebootstrap User", role: "citizen" },
    },
    firstRes
  );
  assert.equal(firstRes.statusCode, 200);
  assert.equal(firstRes.body.role, "citizen");

  const secondRes = createRes();
  await bootstrapHandler(
    {
      auth: { uid: "uid-rebootstrap", email: "rebootstrap@example.com" },
      body: { full_name: "Rebootstrap User", role: "STUDENT" },
    },
    secondRes
  );
  assert.equal(secondRes.statusCode, 200);
  assert.equal(secondRes.body.role, "student");
  assert.deepEqual(insertedRoles, ["citizen", "student"]);
});

test("GET /me and GET /users return normalized app role values", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (text, values) => {
    if (text.includes("FROM users") && values[0] === "legacy-uid") {
      return {
        rowCount: 1,
        rows: [
          {
            id: 11,
            firebase_uid: "legacy-uid",
            email: "legacy@example.com",
            full_name: "Legacy User",
            phone_number: null,
            role: "citizen",
            profile_image_url: null,
          },
        ],
      };
    }
    if (text.includes("FROM users") && values[0] === "new-uid") {
      return {
        rowCount: 1,
        rows: [
          {
            id: 22,
            firebase_uid: "new-uid",
            email: "new@example.com",
            full_name: "New User",
            phone_number: null,
            role: "student",
            profile_image_url: null,
          },
        ],
      };
    }
    throw new Error("Unexpected query");
  };

  const meRes = createRes();
  await getMeHandler({ auth: { uid: "legacy-uid" } }, meRes);
  assert.equal(meRes.statusCode, 200);
  assert.equal(meRes.body.role, "citizen");

  const usersRes = createRes();
  await getUsersHandler({ auth: { uid: "new-uid" } }, usersRes);
  assert.equal(usersRes.statusCode, 200);
  assert.equal(usersRes.body.role, "student");
});

test("GET /users/search is protected by requireAppAuth", () => {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/users/search" && entry.route.methods?.get
  );

  assert.ok(layer);
  assert.equal(layer.route.stack[0].handle, requireAppAuth);
});

test("GET /users/search returns 400 for missing, empty, or too-short queries", async (t) => {
  const invalidQueries = [undefined, "", " ", "a"];

  for (const q of invalidQueries) {
    const req = {
      auth: { uid: "search-uid" },
      query: q === undefined ? {} : { q },
    };
    const res = createRes();

    await searchUsersHandler(req, res);

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { message: "Search query must be at least 2 characters" });
  }
});

test("GET /users/search returns 404 when the authenticated user has no profile row", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({ rowCount: 0, rows: [] });

  const req = {
    auth: { uid: "missing-user" },
    query: { q: "john" },
  };
  const res = createRes();

  await searchUsersHandler(req, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: "User not found. Call /me/bootstrap first." });
});

test("GET /users/search performs case-insensitive multi-word discovery with stable ordering and friendship status", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let queryCount = 0;
  pool.query = async (text, values) => {
    queryCount += 1;
    if (queryCount === 1) {
      assert.match(String(text), /SELECT id\s+FROM users\s+WHERE firebase_uid = \$1/i);
      assert.deepEqual(values, ["search-uid"]);
      return { rowCount: 1, rows: [{ id: 77 }] };
    }

    assert.match(String(text), /FROM users u/i);
    assert.match(String(text), /LOWER\(u\.full_name\) LIKE \$4/i);
    assert.match(String(text), /LOWER\(u\.full_name\) LIKE \$5/i);
    assert.match(String(text), /u\.id <> \$1/i);
    assert.match(String(text), /CASE\s+WHEN LOWER\(u\.full_name\) = \$2 THEN 0/i);
    assert.deepEqual(values, [77, "john sm", "john sm%", "%john%", "%sm%", 20]);

    return {
      rowCount: 4,
      rows: [
        {
          id: 11,
          full_name: "John Smalls",
          beacon_code: "BCN-JS1111",
          friendship_status: "already_friends",
        },
        {
          id: 12,
          full_name: "Johnny Smalls",
          beacon_code: "BCN-JS2222",
          friendship_status: "incoming_pending",
        },
        {
          id: 13,
          full_name: "Alice Johnson Smith",
          beacon_code: "BCN-AJS33",
          friendship_status: "outgoing_pending",
        },
        {
          id: 14,
          full_name: "Elton John Smithe",
          beacon_code: "BCN-EJS44",
          friendship_status: "none",
        },
      ],
    };
  };

  const req = {
    auth: { uid: "search-uid" },
    query: { q: "  JoHn   Sm " },
  };
  const res = createRes();

  await searchUsersHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, [
    {
      id: 11,
      full_name: "John Smalls",
      beacon_code: "BCN-JS1111",
      friendship_status: "already_friends",
    },
    {
      id: 12,
      full_name: "Johnny Smalls",
      beacon_code: "BCN-JS2222",
      friendship_status: "incoming_pending",
    },
    {
      id: 13,
      full_name: "Alice Johnson Smith",
      beacon_code: "BCN-AJS33",
      friendship_status: "outgoing_pending",
    },
    {
      id: 14,
      full_name: "Elton John Smithe",
      beacon_code: "BCN-EJS44",
      friendship_status: "none",
    },
  ]);
});
