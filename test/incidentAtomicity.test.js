import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import router from "../src/routes/incidentRoutes.js";
import { Counter } from "../src/models/Counter.js";
import { AdminAccount, IncidentEvidence, IncidentReport, UserProfile } from "../src/models/Remaining.js";

function stub(t, target, key, replacement) {
  const original = target[key];
  target[key] = replacement;
  t.after(() => { target[key] = original; });
}

test("POST /incidents saves the report and evidence in one Mongo transaction", async (t) => {
  const layer = router.stack.find((entry) => entry.route?.path === "/incidents" && entry.route.methods?.post);
  assert.ok(layer);
  const handler = layer.route.stack.at(-1).handle;
  const calls = [];
  const session = {
    async withTransaction(work) { calls.push("transaction"); return work(); },
    async endSession() { calls.push("end"); },
  };
  stub(t, mongoose, "startSession", async () => session);
  stub(t, UserProfile, "findOne", async () => ({ public_id: 7 }));
  let id = 30;
  stub(t, Counter, "nextPublicId", async () => ++id);
  stub(t, IncidentReport, "create", async (docs, options) => {
    calls.push("report");
    assert.equal(options.session, session);
    return docs;
  });
  stub(t, IncidentEvidence, "create", async (docs, options) => {
    calls.push("evidence");
    assert.equal(options.session, session);
    return docs;
  });
  stub(t, AdminAccount, "find", () => ({ select() { return this; }, lean: async () => [] }));

  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ auth: { uid: "firebase-7" }, body: { incident_type: "Fire", description: "Smoke in building", images: ["data:image/jpeg;base64,/9j/2Q=="] } }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.images_count, 1);
  assert.deepEqual(calls, ["transaction", "report", "evidence", "end"]);
});
