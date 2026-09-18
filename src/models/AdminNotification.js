import mongoose from "mongoose";

function isPublicId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

const adminNotificationSchema = new mongoose.Schema(
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
    recipient_admin_id: { type: Number, required: true, min: 1 },
    type: { type: String, required: true, maxlength: 50 },
    title: { type: String, required: true, maxlength: 150 },
    message: { type: String, required: true, maxlength: 5000 },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      validate: {
        validator: (value) => value == null || isPlainObject(value),
        message: "metadata must be an object",
      },
    },
    is_read: { type: Boolean, required: true, default: false },
    created_at: { type: Date, required: true, default: Date.now },
  },
  { collection: "notifications", versionKey: false }
);

adminNotificationSchema.index({ recipient_admin_id: 1, created_at: -1 });

export const AdminNotification =
  mongoose.models.AdminNotification ??
  mongoose.model("AdminNotification", adminNotificationSchema);
