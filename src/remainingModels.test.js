import test from "node:test";
import assert from "node:assert/strict";
import {
  UserProfile, AdminAccount, EmergencyContact, FriendRequest, Friendship, Device,
  SosThread, SosEvent, IncidentReport, IncidentEvidence, AdminAccessRequest,
} from "./models/Remaining.js";

test("remaining Mongo models expose positive public IDs and reject invalid enums", () => {
  const invalidUser = new UserProfile({ public_id: 0, firebase_uid: "uid", full_name: "User", email: "u@example.com", role: "admin" });
  assert.ok(invalidUser.validateSync().errors.public_id);
  assert.ok(invalidUser.validateSync().errors.role);

  const invalidSos = new SosEvent({ public_id: 1, user_id: 1, status: "bogus" });
  assert.ok(invalidSos.validateSync().errors.status);
});

test("remaining Mongo models define required uniqueness indexes", () => {
  assert.ok(UserProfile.schema.indexes().some(([fields, options]) => fields.email === 1 && options.unique));
  assert.ok(AdminAccount.schema.indexes().some(([fields, options]) => fields.email === 1 && options.unique));
  assert.ok(FriendRequest.schema.indexes().some(([fields, options]) => fields.requester_user_id === 1 && options.unique));
  assert.ok(Friendship.schema.indexes().some(([fields, options]) => fields.user_id === 1 && options.unique));
  assert.ok(Device.schema.indexes().some(([fields, options]) => fields.fcm_token === 1 && options.unique));
  assert.ok(EmergencyContact.schema.indexes().some(([fields]) => fields.owner_user_id === 1));
  assert.ok(SosThread.schema.indexes().some(([fields]) => fields.latest_status === 1));
  assert.ok(SosEvent.schema.indexes().some(([fields]) => fields.sos_id === 1));
  assert.ok(IncidentReport.schema.indexes().some(([fields]) => fields.status === 1));
  assert.ok(IncidentEvidence.schema.indexes().some(([fields]) => fields.incident_report_id === 1));
  assert.ok(AdminAccessRequest.schema.indexes().some(([fields]) => fields.personnel_admin_id === 1));
});
