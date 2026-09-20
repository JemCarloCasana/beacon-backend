import express from "express";
import { requireAdminAuth, requirePermission } from "../middleware/adminAuth.js";
import { sendBroadcastPush } from "../services/fcm.js";
import { sendBroadcastByPublicId } from "../services/broadcastSend.js";
import { auditLog } from "../utils/auditLog.js";
import { toBroadcastRow } from "./broadcastRoutes.js";

const router = express.Router();

router.post(
  "/admin/broadcasts/:id/publish",
  requireAdminAuth,
  requirePermission("manage_broadcasts"),
  async (req, res) => {
    const broadcastId = Number(req.params.id);
    if (!Number.isInteger(broadcastId) || broadcastId <= 0) {
      return res.status(400).json({ message: "Invalid broadcast id" });
    }

    try {
      let outcome;
      try {
        outcome = await sendBroadcastByPublicId(broadcastId);
      } catch (sendErr) {
        console.error("publish broadcast error:", sendErr);
        return res.status(500).json({ message: "Server error" });
      }

      if (outcome.status === "not_found") {
        return res.status(404).json({ message: "Broadcast not found" });
      }

      if (outcome.status === "already_sent") {
        return res.status(409).json({ message: "Broadcast already sent" });
      }

      const b = outcome.broadcast;
      const push = await sendBroadcastPush({
        broadcastPublicId: broadcastId,
        title: b.title,
        body: b.body,
        data: {
          type: "broadcast",
          broadcast_id: b.public_id,
          severity: b.severity ?? "",
          audience_type: b.audience_type ?? "",
        },
      });

      auditLog({
        action: "broadcast.published",
        actor: Number(req.admin?.adminId),
        target: `broadcast:${broadcastId}`,
        outcome: "sent",
        details: { deliveredCount: outcome.deliveredCount },
      });

      return res.json({
        broadcast: toBroadcastRow(b),
        delivered_count: outcome.deliveredCount,
        push,
      });
    } catch (e) {
      console.error("publish broadcast error:", e);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

export default router;
