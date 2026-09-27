import mongoose from "mongoose";

const { Schema } = mongoose;
const objectId = { type: Schema.Types.ObjectId, required: true };
const timestamp = { type: Date, default: Date.now };
const model = (name, schema, collection) => mongoose.models[name] ?? mongoose.model(name, schema, collection);

const contactSchema = new Schema({
  contact_name: { type: String, required: true, maxlength: 100 },
  phone_number: { type: String, required: true, maxlength: 30 },
  relation: { type: String, maxlength: 50 },
  is_primary: { type: Boolean, default: false },
  created_at: timestamp,
  updated_at: timestamp,
}, { _id: true, versionKey: false });

const deviceSchema = new Schema({
  fcm_token: { type: String, required: true },
  platform: { type: String, enum: ["android", "ios", "web"], default: "android" },
  is_active: { type: Boolean, default: true },
  created_at: timestamp,
  updated_at: timestamp,
}, { _id: true, versionKey: false });

const userProfileSchema = new Schema({
  firebase_uid: { type: String, required: true, unique: true, maxlength: 128 },
  full_name: { type: String, required: true, maxlength: 50 },
  email: { type: String, required: true, maxlength: 320, unique: true },
  phone_number: { type: String, maxlength: 20 },
  profile_image_url: String,
  role: { type: String, enum: ["citizen", "student"], required: true, default: "citizen" },
  status: { type: String, enum: ["active", "deactivated"], required: true, default: "active" },
  beacon_code: { type: String, maxlength: 12, unique: true, sparse: true },
  emergency_contacts: { type: [contactSchema], default: [] },
  devices: { type: [deviceSchema], default: [] },
  created_at: timestamp,
  updated_at: timestamp,
}, { collection: "user_profiles", versionKey: false });
userProfileSchema.index({ "devices.fcm_token": 1 }, { unique: true, sparse: true });

const adminRecordSchema = new Schema({
  record_type: { type: String, enum: ["account", "access_request"], required: true },
  email: String,
  password_hash: String,
  full_name: String,
  role: { type: String, enum: ["admin", "personnel"] },
  role_definition: Schema.Types.Mixed,
  permissions: { type: [String], default: undefined },
  permission_definitions: { type: [Schema.Types.Mixed], default: undefined },
  status: String,
  personnel_admin_id: Schema.Types.ObjectId,
  requested_by_admin_id: Schema.Types.ObjectId,
  reviewed_by_admin_id: Schema.Types.ObjectId,
  note: String,
  decision_note: String,
  reviewed_at: Date,
  created_at: timestamp,
  updated_at: timestamp,
}, { collection: "admin_records", versionKey: false, strict: true });
adminRecordSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { record_type: "account" } });
adminRecordSchema.index({ personnel_admin_id: 1, status: 1, created_at: -1 }, { partialFilterExpression: { record_type: "access_request" } });

const friendConnectionSchema = new Schema({
  record_type: { type: String, enum: ["request", "friendship"], required: true },
  user_ids: { type: [Schema.Types.ObjectId], required: true, validate: (ids) => ids.length === 2 },
  requested_by: Schema.Types.ObjectId,
  recipient: Schema.Types.ObjectId,
  status: { type: String, enum: ["pending", "accepted", "declined", "cancelled"] },
  created_at: timestamp,
  updated_at: timestamp,
  accepted_at: Date,
}, { collection: "friend_connections", versionKey: false });
friendConnectionSchema.index({ user_ids: 1, record_type: 1, status: 1, created_at: -1 });
friendConnectionSchema.index({ requested_by: 1, status: 1, created_at: -1 });

const sosRecordSchema = new Schema({
  record_type: { type: String, enum: ["case", "event"], required: true },
  root_event_id: Schema.Types.ObjectId,
  user_id: objectId,
  latest_status: { type: String, enum: ["active", "resolved"] },
  emergency_category: { type: String, enum: ["medical", "fire", "violence", "unknown"] },
  acknowledged_at: Date,
  acknowledged_by_admin_id: Schema.Types.ObjectId,
  resolved_at: Date,
  assigned_unit: String,
  terminal_status: { type: String, enum: ["cancelled", "safe"] },
  resolved_source: { type: String, enum: ["android"] },
  sos_id: Schema.Types.ObjectId,
  thread_id: Schema.Types.ObjectId,
  latitude: Number,
  longitude: Number,
  address: String,
  message: String,
  status: { type: String, enum: ["active", "resolved", "acknowledged", "cancelled", "safe"] },
  actor_type: { type: String, enum: ["user", "admin"] },
  actor_admin_id: Schema.Types.ObjectId,
  event_type: { type: String, enum: ["report_created", "status_update", "admin_acknowledged", "note"] },
  created_at: timestamp,
  updated_at: timestamp,
}, { collection: "sos_records", versionKey: false });
sosRecordSchema.index({ record_type: 1, latest_status: 1, updated_at: -1 });
sosRecordSchema.index({ record_type: 1, thread_id: 1, created_at: -1 });
sosRecordSchema.index({ record_type: 1, sos_id: 1, created_at: -1 });

const evidenceSchema = new Schema({
  image_url: String,
  image_data: Buffer,
  content_type: { type: String, maxlength: 100 },
  sort_order: { type: Number, default: 0 },
  created_at: timestamp,
}, { _id: true, versionKey: false });

const incidentReportSchema = new Schema({
  user_id: objectId,
  incident_type: { type: String, required: true, maxlength: 50 },
  description: { type: String, required: true },
  latitude: Number,
  longitude: Number,
  address: String,
  status: { type: String, enum: ["pending", "dispatched", "in_progress", "resolved"], default: "pending" },
  priority: { type: String, enum: ["critical", "high", "medium", "low"], default: "medium" },
  assigned_department: String,
  resolution_notes: String,
  evidence: { type: [evidenceSchema], default: [] },
  created_at: timestamp,
  updated_at: timestamp,
  dispatched_at: Date,
  resolved_at: Date,
}, { collection: "incident_reports", versionKey: false });
incidentReportSchema.index({ status: 1, created_at: -1 });
incidentReportSchema.index({ priority: 1, created_at: -1 });
incidentReportSchema.index({ user_id: 1, created_at: -1 });

const broadcastSchema = new Schema({
  title: { type: String, required: true, maxlength: 200 },
  body: { type: String, required: true, maxlength: 5000 },
  severity: { type: String, required: true, enum: ["announcement", "warning", "danger"] },
  audience_type: { type: String, required: true, enum: ["all", "role"] },
  audience_roles: { type: [String], default: undefined },
  created_by_admin_id: objectId,
  is_active: { type: Boolean, required: true, default: true },
  sent_at: { type: Date, default: null },
  created_at: timestamp,
  updated_at: timestamp,
}, { collection: "broadcasts", versionKey: false });
broadcastSchema.index({ created_at: -1 });
broadcastSchema.index({ sent_at: -1 });

const notificationSchema = new Schema({
  record_type: { type: String, enum: ["user", "admin", "broadcast_delivery"], required: true },
  recipient_type: { type: String, enum: ["user", "admin"], required: true },
  recipient_id: objectId,
  type: { type: String, required: true, maxlength: 100 },
  title: { type: String, required: true, maxlength: 300 },
  message: { type: String, required: true, maxlength: 5000 },
  source: { type: Schema.Types.Mixed, default: undefined },
  metadata: { type: Schema.Types.Mixed, default: {} },
  is_read: { type: Boolean, required: true, default: false },
  delivered_at: Date,
  acknowledged_at: { type: Date, default: null },
  created_at: timestamp,
}, { collection: "notifications", versionKey: false });
notificationSchema.index({ recipient_type: 1, recipient_id: 1, created_at: -1 });
notificationSchema.index({ source: 1 });
notificationSchema.index({ "source.id": 1, recipient_id: 1 }, { unique: true, partialFilterExpression: { record_type: "broadcast_delivery" } });

const reportRunSchema = new Schema({
  report_key: { type: String, required: true, enum: ["daily_safety_report", "weekly_safety_report", "monthly_safety_report"], maxlength: 64 },
  range_key: { type: String, required: true, enum: ["24h", "7d", "30d"], maxlength: 8 },
  timezone: { type: String, required: true, maxlength: 64 },
  generated_by_admin_id: Schema.Types.ObjectId,
  generated_at: { type: Date, required: true, default: Date.now },
  payload_hash: { type: String, default: null, maxlength: 64 },
}, { collection: "admin_report_runs", versionKey: false });
reportRunSchema.index({ report_key: 1, range_key: 1, timezone: 1, generated_at: -1 });
reportRunSchema.index({ generated_at: -1 });

export const ReducedUserProfile = model("ReducedUserProfile", userProfileSchema, "user_profiles");
export const AdminRecord = model("AdminRecord", adminRecordSchema, "admin_records");
export const FriendConnection = model("FriendConnection", friendConnectionSchema, "friend_connections");
export const SosRecord = model("SosRecord", sosRecordSchema, "sos_records");
export const ReducedIncidentReport = model("ReducedIncidentReport", incidentReportSchema, "incident_reports");
export const ReducedBroadcast = model("ReducedBroadcast", broadcastSchema, "broadcasts");
export const Notification = model("Notification", notificationSchema, "notifications");
export const ReducedReportRun = model("ReducedReportRun", reportRunSchema, "admin_report_runs");
