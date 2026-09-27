import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  AdminRecord,
  FriendConnection,
  Notification,
  ReducedBroadcast,
  ReducedIncidentReport,
  ReducedReportRun,
  ReducedUserProfile,
  SosRecord,
} from "../src/models/Reduced.js";

test("reduced Mongo models define exactly eight collections and no numeric public IDs", () => {
  const collections = Object.values(mongoose.models).map((model) => model.collection.collectionName).sort();
  assert.deepEqual(collections, [
    "admin_records",
    "admin_report_runs",
    "broadcasts",
    "friend_connections",
    "incident_reports",
    "notifications",
    "sos_records",
    "user_profiles",
  ]);
  for (const model of Object.values(mongoose.models)) {
    assert.equal(model.schema.path("public_id"), undefined);
  }

  const invalidUser = new ReducedUserProfile({
    firebase_uid: "uid",
    full_name: "User",
    email: "u@example.com",
    role: "admin",
  });
  assert.ok(invalidUser.validateSync().errors.role);

  const invalidSosEvent = new SosRecord({
    record_type: "event",
    user_id: new mongoose.Types.ObjectId(),
    status: "bogus",
  });
  assert.ok(invalidSosEvent.validateSync().errors.status);
});

test("reduced collections define their relationship and lookup indexes", () => {
  assert.ok(ReducedUserProfile.schema.indexes().some(([fields, options]) => fields.email === 1 && options.unique));
  assert.ok(AdminRecord.schema.indexes().some(([fields, options]) => fields.email === 1 && options.unique));
  assert.ok(FriendConnection.schema.indexes().some(([fields]) => fields.user_ids === 1));
  assert.ok(SosRecord.schema.indexes().some(([fields]) => fields.thread_id === 1));
  assert.ok(ReducedIncidentReport.schema.indexes().some(([fields]) => fields.status === 1));
  assert.ok(ReducedBroadcast.schema.indexes().some(([fields]) => fields.created_at === -1));
  assert.ok(Notification.schema.indexes().some(([fields]) => fields.recipient_id === 1));
  assert.ok(ReducedReportRun.schema.indexes().some(([fields]) => fields.report_key === 1));
});
