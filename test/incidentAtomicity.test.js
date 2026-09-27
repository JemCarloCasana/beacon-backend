import test from "node:test";
import assert from "node:assert/strict";
import router from "../src/routes/incidentRoutes.js";
import { AdminRecord, ReducedIncidentReport as IncidentReport, ReducedUserProfile as UserProfile } from "../src/models/Reduced.js";
import { mongoose } from "../src/mongo.js";

function stub(t, target, key, replacement) {
  const original = target[key];
  target[key] = replacement;
  t.after(() => { target[key] = original; });
}

test("POST /incidents embeds evidence in a single Mongo document", async (t) => {
  const layer = router.stack.find((entry) => entry.route?.path === "/incidents" && entry.route.methods?.post);
  assert.ok(layer);
  const handler = layer.route.stack.at(-1).handle;
  const calls = [];
  const profileId = new mongoose.Types.ObjectId();
  stub(t, UserProfile, "findOne", async () => ({ _id: profileId }));
  stub(t, IncidentReport, "create", async (doc) => {
    calls.push("report");
    const report = new IncidentReport(doc);
    assert.equal(report.user_id.toString(), profileId.toString());
    assert.equal(report.evidence.length, 1);
    return report;
  });
  stub(t, AdminRecord, "find", () => ({ select() { return this; }, lean: async () => [] }));

  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ auth: { uid: "firebase-7" }, body: { incident_type: "Fire", description: "Smoke in building", images: ["data:image/jpeg;base64,/9j/2Q=="] } }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.images_count, 1);
  assert.equal(typeof res.body.id, "string");
  assert.deepEqual(calls, ["report"]);
});
