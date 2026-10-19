import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import router from "../src/routes/publicUserRoutes.js";
import { ReducedUserProfile as UserProfile } from "../src/models/Reduced.js";

function routeLayer(path, method) {
  const found = router.stack.find((entry) => entry.route?.path === path && entry.route.methods?.[method]);
  assert.ok(found, `${method.toUpperCase()} ${path} exists`);
  return found.route;
}

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function stub(t, model, method, replacement) {
  const original = model[method];
  model[method] = replacement;
  t.after(() => { model[method] = original; });
}

test("GET /users/:id/public requires app authentication", () => {
  const names = routeLayer("/users/:id/public", "get").stack.map((entry) => entry.handle?.name);
  assert.ok(names.includes("requireAppAuth"), `requireAppAuth is wired, got: ${names.join(",")}`);
});

test("GET /users/:id/public returns the limited public payload for an authenticated caller", async (t) => {
  const id = new mongoose.Types.ObjectId();
  stub(t, UserProfile, "findById", async () => ({ _id: id, full_name: "Alex User", beacon_code: "BCN-ABC123" }));
  const res = response();
  await routeLayer("/users/:id/public", "get").stack.at(-1).handle({ params: { id: id.toString() } }, res);
  assert.deepEqual(res.body, { id: id.toString(), full_name: "Alex User", beacon_code: "BCN-ABC123" });
});
