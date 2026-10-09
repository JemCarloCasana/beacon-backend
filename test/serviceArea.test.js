import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import mongoose from "mongoose";
import admin from "../src/firebaseAdmin.js";
import { app } from "../server.js";
import { setVerifyIdTokenForTests } from "../src/middleware/requireAuth.js";
import { ReducedUserProfile as UserProfile, SosRecord, ReducedIncidentReport as IncidentReport, Notification } from "../src/models/Reduced.js";

const boundary = JSON.parse(readFileSync(new URL("../src/data/dagupan-city.geojson", import.meta.url), "utf8"));
const inside = { latitude: 16.043502806506392, longitude: 120.3354064229617 };
const outside = { latitude: 14.5995, longitude: 120.9842 };
let server;
let baseUrl;
test.before(async () => {
  server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); });

function authenticated(t, existing = null) {
  let creates = 0;
  setVerifyIdTokenForTests(async () => ({ uid: "city-user", email: "student@example.com", name: "City Student" }));
  t.after(() => setVerifyIdTokenForTests(null));
  t.mock.method(UserProfile, "findOne", async () => existing);
  t.mock.method(UserProfile, "create", async values => { creates++; return new UserProfile(values); });
  t.mock.method(mongoose, "startSession", async () => ({ withTransaction: async callback => callback(), endSession: async () => {} }));
  const sideEffects = [SosRecord, IncidentReport, Notification].flatMap(model =>
    ["create", "insertMany"].map(method => t.mock.method(model, method, async () => {
      throw new Error("Rejected requests must not create records");
    })));
  sideEffects.push(t.mock.getter(admin, "messaging", () => { throw new Error("Rejected requests must not send push"); }));
  t.after(() => sideEffects.forEach(effect => assert.equal(effect.mock.calls.length, 0)));
  return () => creates;
}
async function request(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer city-token", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test("GET /service-area supplies the same boundary without authentication or a database", async () => {
  const response = await fetch(`${baseUrl}/service-area`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await response.json(), boundary);
});

test("new profile registration rejects missing, invalid, and outside-city coordinates before creation", async t => {
  const creates = authenticated(t);
  for (const [location, status, code] of [
    [{}, 400, "LOCATION_REQUIRED"],
    [{ latitude: 16 }, 400, "INVALID_LOCATION"],
    [{ latitude: "16", longitude: 120 }, 400, "INVALID_LOCATION"],
    [{ latitude: 91, longitude: 120 }, 400, "INVALID_LOCATION"],
    [outside, 422, "OUTSIDE_SERVICE_AREA"],
  ]) {
    const result = await request("/me/bootstrap", { full_name: "City Student", role: "student", ...location });
    assert.equal(result.status, status);
    assert.equal(result.body.code, code);
  }
  assert.equal(creates(), 0);
});

test("new profiles can register inside Dagupan and on its boundary", async t => {
  const creates = authenticated(t);
  const [longitude, latitude] = boundary.features[0].geometry.coordinates[0][0];
  for (const location of [inside, { latitude, longitude }]) {
    const result = await request("/me/bootstrap", { full_name: "City Student", role: "student", ...location });
    assert.equal(result.status, 200);
    assert.equal(result.body.role, "student");
  }
  assert.equal(creates(), 2);
});

test("Firebase identity alone cannot create a Beacon profile through other protected endpoints", async t => {
  const creates = authenticated(t);
  for (const [path, body] of [
    ["/me", undefined], ["/admin/broadcasts/my/inbox", undefined],
    ["/sos", { category: "medical", ...inside }],
    ["/incidents", { incident_type: "Fire", description: "Smoke", ...inside }],
  ]) {
    const result = await request(path, body);
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "PROFILE_SETUP_REQUIRED");
  }
  assert.equal(creates(), 0);
});

test("existing users keep account access and re-bootstrap outside Dagupan", async t => {
  const profile = new UserProfile({ firebase_uid: "city-user", email: "student@example.com", full_name: "City Student", role: "student", beacon_code: "BCN-ABC123" });
  t.mock.method(profile, "save", async () => profile);
  const creates = authenticated(t, profile);
  assert.equal((await request("/me")).status, 200);
  const result = await request("/me/bootstrap", { full_name: "City Student", role: "student", ...outside });
  assert.equal(result.status, 200);
  assert.equal(creates(), 0);
});

test("direct SOS and incident API calls reject out-of-city or missing coordinates before side effects", async t => {
  const profile = new UserProfile({ firebase_uid: "city-user", email: "student@example.com", full_name: "City Student", beacon_code: "BCN-ABC123" });
  t.mock.method(profile, "save", async () => profile);
  authenticated(t, profile);
  for (const [path, body] of [["/sos", { category: "medical" }], ["/incidents", { incident_type: "Fire", description: "Smoke" }]]) {
    for (const [location, status, code] of [
      [outside, 422, "OUTSIDE_SERVICE_AREA"], [{}, 400, "LOCATION_REQUIRED"],
      [{ latitude: 16 }, 400, "INVALID_LOCATION"],
      [{ latitude: "16.0435", longitude: 120.3354 }, 400, "INVALID_LOCATION"],
      [{ latitude: 16.0435, longitude: 181 }, 400, "INVALID_LOCATION"],
    ]) {
      const result = await request(path, { ...body, ...location });
      assert.equal(result.status, status);
      assert.equal(result.body.code, code);
    }
  }
});

test("polygon validation handles edges, holes, islands, invalid numbers, and real city exclusions", async () => {
  const { containsLocation, getServiceAreaError } = await import("../src/utils/serviceArea.js");
  const polygon = { type: "Polygon", coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]],
  ] };
  const islands = { type: "MultiPolygon", coordinates: [polygon.coordinates, [[[12, 0], [14, 0], [14, 2], [12, 2], [12, 0]]]] };
  for (const [latitude, longitude, expected] of [[1, 1, true], [5, 5, false], [0, 5, true], [0, 0, true], [5, 3, true], [5, 11, false]]) {
    assert.equal(containsLocation(latitude, longitude, polygon), expected);
  }
  assert.equal(containsLocation(1, 13, islands), true);
  assert.equal(containsLocation(1, 11, islands), false);
  const smallTriangle = { type: "Polygon", coordinates: [[[1, 1], [1.000001, 1], [1, 1.000001], [1, 1]]] };
  assert.equal(containsLocation(1.0000009, 1.0000009, smallTriangle), false);
  for (const [latitude, longitude] of [[NaN, 120], [16, Infinity], [-Infinity, 120], [91, 120], [16, 181], ["16", 120], [null, 120], [false, 120], [16, {}], [16, ""]]) {
    assert.equal(getServiceAreaError(latitude, longitude).statusCode, 400);
  }
  assert.equal(getServiceAreaError(inside.latitude, inside.longitude), null);
  const ring = boundary.features[0].geometry.coordinates[0];
  for (let index = 1; index < ring.length; index++) {
    const [ax, ay] = ring[index - 1];
    const [bx, by] = ring[index];
    assert.equal(getServiceAreaError(ay, ax), null);
    assert.equal(getServiceAreaError((ay + by) / 2, (ax + bx) / 2), null);
  }
  // Binmaley, Calasiao, and a corner inside the rectangle but outside the city.
  for (const [latitude, longitude] of [[16.031, 120.269], [16.012, 120.362], [16.11, 120.30]]) {
    assert.equal(getServiceAreaError(latitude, longitude).statusCode, 422);
  }
});
