import mongoose from "mongoose";

const REPORT_KEYS = ["daily_safety_report", "weekly_safety_report", "monthly_safety_report"];
const RANGE_KEYS = ["24h", "7d", "30d"];

function isPublicId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

const reportRunSchema = new mongoose.Schema(
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
    report_key: { type: String, required: true, enum: REPORT_KEYS, maxlength: 64 },
    range_key: { type: String, required: true, enum: RANGE_KEYS, maxlength: 8 },
    timezone: { type: String, required: true, maxlength: 64 },
    generated_by_admin_id: { type: Number, default: null, min: 1 },
    generated_at: { type: Date, required: true, default: Date.now },
    payload_hash: { type: String, default: null, maxlength: 64 },
  },
  { collection: "admin_report_runs", versionKey: false }
);

reportRunSchema.index({ report_key: 1, range_key: 1, timezone: 1, generated_at: -1 });
reportRunSchema.index({ generated_at: -1 });

export const ReportRun =
  mongoose.models.ReportRun ?? mongoose.model("ReportRun", reportRunSchema);
