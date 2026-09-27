import test from "node:test";
import assert from "node:assert/strict";

import router from "../src/routes/meRoutes.js";
import { requireAppAuth } from "../src/middleware/requireAppAuth.js";
import mongoose from "mongoose";
import { FriendConnection, ReducedUserProfile as UserProfile } from "../src/models/Reduced.js";

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

function queryResult(value) {
  return {
    select() { return this; },
    limit() { return this; },
    lean: async () => value,
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

function profile(values) {
  return { ...values, _id: values._id ?? new mongoose.Types.ObjectId(), save: async () => {} };
}

function replaceMethod(t, model, method, replacement) {
  const original = model[method];
  model[method] = replacement;
  t.after(() => { model[method] = original; });
}

test("POST /me/bootstrap accepts citizen and normalizes mixed-case role", async (t) => {
  let receivedRole = null;
  replaceMethod(t, UserProfile, "findOne", () => queryResult(null));
  replaceMethod(t, UserProfile, "create", async (values) => {
    receivedRole = values.role;
    return profile({ ...values, profile_image_url: null });
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
});

test("POST /me/bootstrap accepts student role", async (t) => {
  replaceMethod(t, UserProfile, "findOne", () => queryResult(null));
  replaceMethod(t, UserProfile, "create", async (values) => profile({ ...values, profile_image_url: null }));

  const req = {
    auth: { uid: "uid-student", email: "student@example.com" },
    body: { full_name: "Student User", role: "student" },
  };
  const res = createRes();

  await bootstrapHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.role, "student");
});

test("POST /me/bootstrap rejects missing role", async () => {
  const req = {
    auth: { uid: "uid-missing-role", email: "missing-role@example.com" },
    body: { full_name: "Missing Role" },
  };
  const res = createRes();

  await bootstrapHandler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid role" });
});

test("POST /me/bootstrap rejects unknown role", async () => {
  const req = {
    auth: { uid: "uid-unknown-role", email: "unknown-role@example.com" },
    body: { full_name: "Unknown Role", role: "teacher" },
  };
  const res = createRes();

  await bootstrapHandler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid role" });
});

test("POST /me/bootstrap updates role to latest submitted value on re-bootstrap", async (t) => {
  const existing = profile({ firebase_uid: "uid-rebootstrap", email: "rebootstrap@example.com", full_name: "Rebootstrap User", phone_number: null, role: "citizen", status: "active", beacon_code: "BCN-ABC123" });
  replaceMethod(t, UserProfile, "findOne", () => queryResult(existing));

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
  assert.equal(existing.role, "student");
});

test("GET /me and GET /users return normalized app role values", async (t) => {
  replaceMethod(t, UserProfile, "findOne", ({ firebase_uid }) => queryResult(profile({ firebase_uid, email: firebase_uid === "legacy-uid" ? "legacy@example.com" : "new@example.com", full_name: firebase_uid === "legacy-uid" ? "Legacy User" : "New User", phone_number: null, role: firebase_uid === "legacy-uid" ? "citizen" : "student", profile_image_url: null })));

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
  replaceMethod(t, UserProfile, "findOne", () => queryResult(null));

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
  const me = new mongoose.Types.ObjectId();
  const [john, johnny, alice, elton] = Array.from({ length: 4 }, () => new mongoose.Types.ObjectId());
  replaceMethod(t, UserProfile, "findOne", ({ firebase_uid }) => queryResult(firebase_uid === "search-uid" ? profile({ _id: me }) : null));
  replaceMethod(t, UserProfile, "find", () => queryResult([
    { _id: john, full_name: "John Smalls", beacon_code: "BCN-JS1111" },
    { _id: johnny, full_name: "Johnny Smalls", beacon_code: "BCN-JS2222" },
    { _id: alice, full_name: "Alice Johnson Smith", beacon_code: "BCN-AJS33" },
    { _id: elton, full_name: "Elton John Smithe", beacon_code: "BCN-EJS44" },
  ]));
  replaceMethod(t, FriendConnection, "find", (filter) => queryResult(filter.record_type === "friendship"
    ? [{ user_ids: [me, john] }]
    : [
      { requested_by: johnny, recipient: me },
      { requested_by: me, recipient: alice },
    ]));

  const req = {
    auth: { uid: "search-uid" },
    query: { q: "  JoHn   Sm " },
  };
  const res = createRes();

  await searchUsersHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, [
    {
      id: alice.toString(),
      full_name: "Alice Johnson Smith",
      beacon_code: "BCN-AJS33",
      friendship_status: "outgoing_pending",
    },
    {
      id: elton.toString(),
      full_name: "Elton John Smithe",
      beacon_code: "BCN-EJS44",
      friendship_status: "none",
    },
    {
      id: john.toString(),
      full_name: "John Smalls",
      beacon_code: "BCN-JS1111",
      friendship_status: "already_friends",
    },
    {
      id: johnny.toString(),
      full_name: "Johnny Smalls",
      beacon_code: "BCN-JS2222",
      friendship_status: "incoming_pending",
    },
  ]);
});
