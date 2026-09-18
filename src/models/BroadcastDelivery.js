import mongoose from "mongoose";

const broadcastDeliverySchema = new mongoose.Schema(
  {
    broadcast_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Broadcast",
      required: true,
    },
    broadcast_public_id: { type: Number, required: true, min: 1 },
    recipient_user_id: { type: Number, required: true, min: 1 },
    delivered_at: { type: Date, required: true, default: Date.now },
    acknowledged_at: { type: Date, default: null },
  },
  { collection: "broadcast_user_deliveries", versionKey: false }
);

broadcastDeliverySchema.index({ broadcast_id: 1, recipient_user_id: 1 }, { unique: true });
broadcastDeliverySchema.index(
  { broadcast_public_id: 1, recipient_user_id: 1 },
  { unique: true }
);
broadcastDeliverySchema.index({ recipient_user_id: 1, delivered_at: -1 });

export const BroadcastDelivery =
  mongoose.models.BroadcastDelivery ??
  mongoose.model("BroadcastDelivery", broadcastDeliverySchema);
