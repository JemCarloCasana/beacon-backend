import mongoose from "mongoose";

const SEVERITIES = ["announcement", "warning", "danger"];
const AUDIENCE_TYPES = ["all", "role"];
const AUDIENCE_ROLES = ["citizen", "student"];

export function hasValidBroadcastAudience(broadcast) {
  if (broadcast.audience_type === "all") return true;
  if (broadcast.audience_type !== "role") return false;
  const roles = broadcast.audience_roles;
  if (Array.isArray(roles) && roles.length > 0) {
    return roles.every((role) => AUDIENCE_ROLES.includes(role));
  }
  const ids = broadcast.audience_role_ids;
  return Array.isArray(ids) && ids.length > 0 && ids.every((id) => Number.isSafeInteger(id) && id > 0);
}

function isPublicId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

const broadcastSchema = new mongoose.Schema(
  {
    public_id: {
      type: Number,
      required: true,
      unique: true,
      validate: {
        validator: isPublicId,
        message: "public_id must be a positive safe integer",
      },
    },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 5000 },
    severity: { type: String, required: true, enum: SEVERITIES },
    audience_type: { type: String, required: true, enum: AUDIENCE_TYPES },
    audience_roles: {
      type: [String],
      default: undefined,
      validate: {
        validator: (value) =>
          value == null || value.every((role) => AUDIENCE_ROLES.includes(role)),
        message: "audience_roles must contain only citizen/student",
      },
    },
    audience_role_ids: {
      type: [Number],
      default: undefined,
      validate: {
        validator: (value) =>
          value == null ||
          value.every((id) => Number.isSafeInteger(id) && id > 0),
        message: "audience_role_ids must be positive safe integers",
      },
    },
    created_by_admin_id: { type: Number, required: true, min: 1 },
    is_active: { type: Boolean, required: true, default: true },
    sent_at: { type: Date, default: null },
    created_at: { type: Date, required: true, default: Date.now },
    updated_at: { type: Date, required: true, default: Date.now },
  },
  { collection: "broadcasts", versionKey: false }
);

broadcastSchema.index({ created_at: -1 });
broadcastSchema.pre("validate", function () {
  if (!hasValidBroadcastAudience(this)) {
    this.invalidate("audience_type", "Role audience requires a valid recipient selector");
  }
});
broadcastSchema.index({ sent_at: -1 });

export const Broadcast =
  mongoose.models.Broadcast ?? mongoose.model("Broadcast", broadcastSchema);
