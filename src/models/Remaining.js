import mongoose from "mongoose";

const positiveId = {
  type: Number,
  required: true,
  validate: { validator: (value) => Number.isSafeInteger(value) && value > 0, message: "must be a positive safe integer" },
};
const date = { type: Date, default: Date.now };
const model = (name, schema, collection) => mongoose.models[name] ?? mongoose.model(name, new mongoose.Schema(schema, { collection, versionKey: false }));

const userSchema = {
  public_id: { ...positiveId, unique: true }, firebase_uid: { type: String, required: true, unique: true, maxlength: 128 },
  full_name: { type: String, required: true, maxlength: 50 }, email: { type: String, required: true, maxlength: 320 },
  phone_number: { type: String, maxlength: 20 }, profile_image_url: String,
  role: { type: String, enum: ["citizen", "student"], required: true, default: "citizen" },
  status: { type: String, enum: ["active", "deactivated"], required: true, default: "active" }, created_at: date, updated_at: date,
  beacon_code: { type: String, maxlength: 12, unique: true, sparse: true },
};
const UserProfile = model("UserProfile", userSchema, "user_profiles");
UserProfile.schema.index({ email: 1 }, { unique: true });

const AdminAccount = model("AdminAccount", {
  public_id: { ...positiveId, unique: true }, email: { type: String, required: true, maxlength: 320 }, password_hash: { type: String, required: true },
  full_name: { type: String, required: true }, role_id: positiveId, role: { type: String, enum: ["admin", "personnel"], required: true },
  permission_names: { type: [String], default: [] },
  status: { type: String, enum: ["active", "deactivated"], default: "active" }, created_at: date, updated_at: date,
}, "admin_accounts");
AdminAccount.schema.index({ email: 1 }, { unique: true });

const Role = model("Role", { public_id: { ...positiveId, unique: true }, name: { type: String, required: true, unique: true, maxlength: 50 }, description: String }, "roles");
const Permission = model("Permission", { public_id: { ...positiveId, unique: true }, name: { type: String, required: true, unique: true, maxlength: 50 }, description: String }, "permissions");

const EmergencyContact = model("EmergencyContact", {
  public_id: { ...positiveId, unique: true }, owner_user_id: positiveId, contact_name: { type: String, required: true, maxlength: 100 },
  phone_number: { type: String, required: true, maxlength: 30 }, relation: { type: String, maxlength: 50 }, is_primary: { type: Boolean, default: false }, created_at: date, updated_at: date,
}, "emergency_contacts");
EmergencyContact.schema.index({ owner_user_id: 1, created_at: -1 });
EmergencyContact.schema.index({ owner_user_id: 1, phone_number: 1 }, { unique: true });

const FriendRequest = model("FriendRequest", {
  public_id: { ...positiveId, unique: true }, requester_user_id: positiveId, addressee_user_id: positiveId,
  status: { type: String, enum: ["pending", "accepted", "declined", "cancelled"], default: "pending" }, created_at: date, updated_at: date,
}, "friend_requests");
FriendRequest.schema.index({ requester_user_id: 1, addressee_user_id: 1, status: 1 }, { unique: true, partialFilterExpression: { status: "pending" } });

const Friendship = model("Friendship", { user_id: positiveId, friend_user_id: positiveId, created_at: date }, "friendships");
Friendship.schema.index({ user_id: 1, friend_user_id: 1 }, { unique: true });

const Device = model("Device", {
  public_id: { ...positiveId, unique: true }, user_id: positiveId, fcm_token: { type: String, required: true },
  platform: { type: String, enum: ["android", "ios", "web"], default: "android" }, is_active: { type: Boolean, default: true }, created_at: date, updated_at: date,
}, "devices");
Device.schema.index({ user_id: 1, is_active: 1 });
Device.schema.index({ fcm_token: 1 }, { unique: true });

const SosThread = model("SosThread", {
  public_id: { ...positiveId, unique: true }, root_event_id: positiveId, user_id: positiveId,
  latest_status: { type: String, enum: ["active", "resolved"], default: "active" }, emergency_category: { type: String, enum: ["medical", "fire", "violence", "unknown"], default: "unknown" },
  acknowledged_at: Date, acknowledged_by_admin_id: Number, resolved_at: Date, assigned_unit: String,
  terminal_status: { type: String, enum: ["cancelled", "safe"] }, resolved_source: { type: String, enum: ["android"] }, created_at: date, updated_at: date,
}, "sos_threads");
SosThread.schema.index({ latest_status: 1, updated_at: -1 });

const SosEvent = model("SosEvent", {
  public_id: { ...positiveId, unique: true }, user_id: positiveId, sos_id: positiveId, thread_id: positiveId,
  latitude: Number, longitude: Number, address: String, message: String,
  status: { type: String, enum: ["active", "resolved", "acknowledged", "cancelled", "safe"], default: "active" },
  actor_type: { type: String, enum: ["user", "admin"], default: "user" }, actor_admin_id: Number,
  event_type: { type: String, enum: ["report_created", "status_update", "admin_acknowledged", "note"], default: "status_update" },
  emergency_category: { type: String, enum: ["medical", "fire", "violence", "unknown"] }, created_at: date,
}, "sos_events");
SosEvent.schema.index({ sos_id: 1, created_at: -1, public_id: -1 });

const IncidentReport = model("IncidentReport", {
  public_id: { ...positiveId, unique: true }, user_id: positiveId, incident_type: { type: String, required: true, maxlength: 50 }, description: { type: String, required: true },
  latitude: Number, longitude: Number, address: String, status: { type: String, enum: ["pending", "dispatched", "in_progress", "resolved"], default: "pending" },
  priority: { type: String, enum: ["critical", "high", "medium", "low"], default: "medium" }, assigned_department: String, assigned_admin_id: Number,
  resolution_notes: String, created_at: date, updated_at: date, dispatched_at: Date, resolved_at: Date,
}, "incident_reports");
IncidentReport.schema.index({ status: 1, created_at: -1 });
IncidentReport.schema.index({ priority: 1, created_at: -1 });

const IncidentEvidence = model("IncidentEvidence", {
  public_id: { ...positiveId, unique: true }, incident_report_id: positiveId, image_url: String, image_data: Buffer, content_type: { type: String, maxlength: 100 }, sort_order: { type: Number, default: 0 }, created_at: date,
}, "incident_evidence");
IncidentEvidence.schema.index({ incident_report_id: 1, created_at: 1 });

const AdminAccessRequest = model("AdminAccessRequest", {
  public_id: { ...positiveId, unique: true }, personnel_admin_id: positiveId, requested_by_admin_id: positiveId,
  status: { type: String, enum: ["pending", "approved", "rejected", "cancelled"], default: "pending" }, note: String, decision_note: String, created_at: date, updated_at: date, reviewed_at: Date, reviewed_by_admin_id: Number,
}, "admin_access_requests");
AdminAccessRequest.schema.index({ personnel_admin_id: 1, status: 1 });

export { UserProfile, AdminAccount, Role, Permission, EmergencyContact, FriendRequest, Friendship, Device, SosThread, SosEvent, IncidentReport, IncidentEvidence, AdminAccessRequest };
