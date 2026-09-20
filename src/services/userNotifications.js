import admin from "../firebaseAdmin.js";
import { pool } from "../db.js";
import { UserNotification } from "../models/UserNotification.js";
import { Counter } from "../models/Counter.js";

let customSendMulticast = null;

export function setUserNotificationMulticastSenderForTests(sendFn) {
  customSendMulticast = typeof sendFn === "function" ? sendFn : null;
}

function toPositiveIntegerOrNull(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function toIso(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function normalizeNotificationMetadata(metadata) {
  if (metadata == null) {
    return {};
  }

  let normalized = metadata;
  if (typeof metadata === "string") {
    try {
      normalized = JSON.parse(metadata);
    } catch {
      return {};
    }
  }

  if (typeof normalized !== "object" || Array.isArray(normalized)) {
    return {};
  }

  return { ...normalized };
}

function normalizeTraceContext(trace) {
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) {
    return {};
  }

  const normalized = {};
  if (trace.requestId != null) normalized.requestId = String(trace.requestId);
  if (trace.action != null) normalized.action = String(trace.action);
  if (trace.entityType != null) normalized.entityType = String(trace.entityType);
  if (trace.entityId != null) normalized.entityId = Number(trace.entityId);
  if (trace.recipientUserId != null) normalized.recipientUserId = Number(trace.recipientUserId);
  if (trace.notificationType != null) normalized.notificationType = String(trace.notificationType);
  if (trace.status != null) normalized.status = String(trace.status);
  return normalized;
}

function logNotificationTrace(event, payload) {
  console.info(`[user-notifications] ${event}`, payload);
}

function buildFallbackRoute(type, metadata) {
  const fallbackRoute =
    typeof metadata.fallback_route === "string" && metadata.fallback_route.trim()
      ? metadata.fallback_route.trim()
      : null;
  if (fallbackRoute) {
    return fallbackRoute;
  }

  if (type === "incident_update" && metadata.incident_id != null) {
    return `/incidents/${metadata.incident_id}`;
  }
  if (type === "sos_update" && metadata.sos_id != null) {
    return `/sos/${metadata.sos_id}`;
  }
  return null;
}

export function normalizeUserNotificationRow(row) {
  if (!row || typeof row !== "object") {
    return row;
  }

  const metadata = normalizeNotificationMetadata(row.metadata);
  const normalized = {
    ...metadata,
  };

  const incidentId = toPositiveIntegerOrNull(normalized.incident_id);
  const sosId = toPositiveIntegerOrNull(normalized.sos_id);
  if (incidentId != null) {
    normalized.incident_id = incidentId;
  }
  if (sosId != null) {
    normalized.sos_id = sosId;
  }

  const createdAt = toIso(normalized.created_at);
  if (createdAt != null) {
    normalized.created_at = createdAt;
  }

  const fallbackRoute = buildFallbackRoute(String(row.type || "").trim(), normalized);
  if (fallbackRoute != null) {
    normalized.fallback_route = fallbackRoute;
  }

  return {
    ...row,
    metadata: normalized,
  };
}

export function toUserNotificationRow(doc) {
  if (!doc || typeof doc !== "object") {
    return doc;
  }
  return {
    id: doc.public_id,
    recipient_user_id: doc.recipient_user_id,
    type: doc.type,
    title: doc.title,
    message: doc.message,
    metadata: doc.metadata,
    is_read: doc.is_read,
    created_at: doc.created_at,
  };
}

function stringifyDataPayload(data) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value != null && value !== "")
      .map(([key, value]) => [key, String(value)])
  );
}

function buildIncidentNotificationBody(status, assignedDepartment) {
  if (status === "dispatched") {
    if (assignedDepartment) {
      return `Your incident report has been dispatched to ${assignedDepartment}.`;
    }
    return "Your incident report has been dispatched.";
  }
  if (status === "in_progress") {
    return "Responders are handling your report now.";
  }
  return "Your incident report has been resolved.";
}

function buildSosNotificationBody(status, assignedUnit) {
  if (status === "acknowledged") {
    if (assignedUnit) {
      return `Your SOS has been acknowledged by ${assignedUnit}.`;
    }
    return "Your SOS has been acknowledged.";
  }
  if (status === "cancelled") {
    return "Your SOS has been cancelled.";
  }
  if (status === "safe") {
    return "Your SOS has been marked safe.";
  }
  return "Your SOS has been resolved.";
}

function buildFriendSosTerminalNotificationBody(status, senderName) {
  const safeSenderName =
    typeof senderName === "string" && senderName.trim() ? senderName.trim() : "Your friend";
  if (status === "cancelled") {
    return `${safeSenderName} cancelled the SOS. It was a false alarm.`;
  }
  if (status === "safe") {
    return `${safeSenderName} is now safe.`;
  }
  return `${safeSenderName}'s SOS has been resolved.`;
}

function buildFriendSosTerminalNotificationTitle(status) {
  if (status === "cancelled") {
    return "SOS Cancelled";
  }
  if (status === "safe") {
    return "SOS Solved";
  }
  return "SOS Resolved";
}

export function buildUserLifecycleNotification(input) {
  const recipientUserId = toPositiveIntegerOrNull(input?.recipient_user_id);
  const entityType = typeof input?.entity_type === "string" ? input.entity_type.trim().toLowerCase() : "";
  const entityId = toPositiveIntegerOrNull(input?.entity_id);
  const status = typeof input?.status === "string" ? input.status.trim().toLowerCase() : "";
  const assignedUnit =
    typeof input?.assigned_unit === "string" && input.assigned_unit.trim()
      ? input.assigned_unit.trim()
      : null;
  const assignedDepartment =
    typeof input?.assigned_department === "string" && input.assigned_department.trim()
      ? input.assigned_department.trim()
      : null;

  if (!recipientUserId || !entityId) {
    return null;
  }

  if (entityType === "incident") {
    const title = "Incident Update";
    const message = buildIncidentNotificationBody(status, assignedDepartment);
    return {
      recipientUserId,
      type: "incident_update",
      title,
      message,
      metadata: {
        incident_id: entityId,
        status,
        assigned_department: assignedDepartment,
        fallback_route: `/incidents/${entityId}`,
      },
      data: {
        type: "incident_update",
        incident_id: entityId,
        status,
        assigned_department: assignedDepartment,
        fallback_route: `/incidents/${entityId}`,
        sender_user_id: recipientUserId,
        title,
        body: message,
      },
    };
  }

  if (entityType !== "sos") {
    return null;
  }

  const title = "SOS Update";
  const message = buildSosNotificationBody(status, assignedUnit);
  return {
    recipientUserId,
    type: "sos_update",
    title,
    message,
    metadata: {
      sos_id: entityId,
      status,
      assigned_unit: assignedUnit,
      fallback_route: `/sos/${entityId}`,
    },
    data: {
      type: "sos_update",
      sos_id: entityId,
      status,
      assigned_unit: assignedUnit,
      fallback_route: `/sos/${entityId}`,
      sender_user_id: recipientUserId,
      sender_name:
        typeof input?.sender_name === "string" && input.sender_name.trim()
          ? input.sender_name.trim()
          : null,
      latitude: input?.latitude,
      longitude: input?.longitude,
      address:
        typeof input?.address === "string" && input.address.trim() ? input.address.trim() : null,
      category:
        typeof input?.category === "string" && input.category.trim() ? input.category.trim() : null,
      title,
      body: message,
    },
  };
}

async function sendMulticastWithCleanup({ tokens, title, body, data, trace = {} }) {
  const resolvedTrace = normalizeTraceContext(trace);

  if (!Array.isArray(tokens) || tokens.length === 0) {
    logNotificationTrace("push_skipped", {
      ...resolvedTrace,
      tokenCount: 0,
      reason: "no_device_tokens",
    });
    return {
      ok: true,
      push: { attempted: false, reason: "no_device_tokens" },
    };
  }

  try {
    const multicastMessage = {
      tokens,
      notification: {
        title,
        body,
      },
      data: stringifyDataPayload(data),
      android: {
        priority: "high",
      },
    };
    const response = customSendMulticast
      ? await customSendMulticast(multicastMessage)
      : await admin.messaging().sendEachForMulticast(multicastMessage);

    const badTokens = [];
    response.responses.forEach((entry, index) => {
      if (!entry.success) {
        const code = entry.error?.code || "";
        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token"
        ) {
          badTokens.push(tokens[index]);
        }
      }
    });

    if (badTokens.length > 0) {
      await pool.query(`DELETE FROM devices WHERE fcm_token = ANY($1)`, [badTokens]);
    }

    logNotificationTrace("push_result", {
      ...resolvedTrace,
      tokenCount: tokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
      removedTokensCount: badTokens.length,
    });

    return {
      ok: true,
      push: {
        attempted: true,
        successCount: response.successCount,
        failureCount: response.failureCount,
        removedTokensCount: badTokens.length,
      },
    };
  } catch (err) {
    console.error("[user-notifications] FCM send failed:", err?.message || err, {
      ...resolvedTrace,
    });
    return {
      ok: true,
      push: { attempted: true, error: "fcm_send_failed" },
    };
  }
}

export async function notifyUserLifecycleEvent(input) {
  const trace = normalizeTraceContext(input?.trace);
  const built = buildUserLifecycleNotification(input);
  if (!built) {
    console.warn("[user-notifications] skipping notification because recipient or payload is invalid", {
      ...trace,
      entityType: input?.entity_type ?? null,
      entityId: input?.entity_id ?? null,
      recipientUserId: input?.recipient_user_id ?? null,
    });
    return { ok: false, skipped: true, reason: "invalid_payload" };
  }

  const resolvedTrace = {
    ...trace,
    entityType: input?.entity_type ?? trace.entityType ?? null,
    entityId: input?.entity_id ?? trace.entityId ?? null,
    recipientUserId: built.recipientUserId,
    notificationType: built.type,
    status: input?.status ?? trace.status ?? null,
  };

  logNotificationTrace("start", resolvedTrace);

  const publicId = await Counter.nextPublicId("user_notifications");
  const created = await UserNotification.create({
    public_id: publicId,
    recipient_user_id: built.recipientUserId,
    type: built.type,
    title: built.title,
    message: built.message,
    metadata: built.metadata,
    is_read: false,
    created_at: new Date(),
  });

  const inserted = normalizeUserNotificationRow(
    toUserNotificationRow(
      typeof created.toObject === "function" ? created.toObject() : created
    )
  );
  inserted.metadata = {
    ...inserted.metadata,
    created_at: toIso(inserted.created_at),
  };

  logNotificationTrace("notification_inserted", {
    ...resolvedTrace,
    notificationId: inserted.id,
  });

  let tokens = [];
  try {
    const tokensResult = await pool.query(
      `
      SELECT DISTINCT fcm_token
      FROM devices
      WHERE user_id = $1
        AND fcm_token IS NOT NULL
      `,
      [built.recipientUserId]
    );
    tokens = tokensResult.rows.map((row) => row.fcm_token).filter(Boolean);
  } catch (err) {
    console.error("[user-notifications] failed to load device tokens:", err?.message || err, {
      ...resolvedTrace,
      recipientUserId: built.recipientUserId,
      notificationId: inserted.id,
    });
    return {
      ok: true,
      notification: inserted,
      push: { attempted: false, error: "token_lookup_failed" },
    };
  }

  logNotificationTrace("device_tokens_loaded", {
    ...resolvedTrace,
    notificationId: inserted.id,
    tokenCount: tokens.length,
  });

  if (tokens.length === 0) {
    const pushResult = await sendMulticastWithCleanup({
      tokens,
      title: built.title,
      body: built.message,
      data: {
        ...built.data,
        created_at: inserted.metadata.created_at,
      },
      trace: {
        ...resolvedTrace,
        notificationId: inserted.id,
      },
    });
    return {
      ok: true,
      notification: inserted,
      push: pushResult.push,
    };
  }

  const pushResult = await sendMulticastWithCleanup({
    tokens,
    title: built.title,
    body: built.message,
    data: {
      ...built.data,
      created_at: inserted.metadata.created_at,
    },
    trace: {
      ...resolvedTrace,
      notificationId: inserted.id,
      type: built.type,
    },
  });

  return {
    ok: true,
    notification: inserted,
    push: pushResult.push,
  };
}

export async function notifySosFriendsTerminalEvent(input) {
  const ownerUserId = toPositiveIntegerOrNull(input?.owner_user_id);
  const sosId = toPositiveIntegerOrNull(input?.sos_id);
  const terminalOutcome =
    typeof input?.terminal_outcome === "string" ? input.terminal_outcome.trim().toLowerCase() : "";

  if (!ownerUserId || !sosId || !["cancelled", "safe", "resolved"].includes(terminalOutcome)) {
    console.warn("[user-notifications] skipping SOS friend notification because payload is invalid", {
      ownerUserId: input?.owner_user_id ?? null,
      sosId: input?.sos_id ?? null,
      terminalOutcome: input?.terminal_outcome ?? null,
    });
    return { ok: false, skipped: true, reason: "invalid_payload" };
  }

  const trace = normalizeTraceContext(input?.trace);
  const senderName =
    typeof input?.sender_name === "string" && input.sender_name.trim()
      ? input.sender_name.trim()
      : "Your friend";
  const fallbackRoute = `/sos/${sosId}`;

  logNotificationTrace("friend_terminal_start", {
    ...trace,
    ownerUserId,
    entityId: sosId,
    status: terminalOutcome,
  });

  let friendUserIds = [];
  try {
    const friendsResult = await pool.query(
      `
      SELECT CASE
               WHEN user_id = $1 THEN friend_user_id
               ELSE user_id
             END AS friend_user_id
      FROM friendships
      WHERE $1 IN (user_id, friend_user_id)
      `,
      [ownerUserId]
    );
    friendUserIds = friendsResult.rows
      .map((row) => toPositiveIntegerOrNull(row.friend_user_id))
      .filter(Boolean);
  } catch (err) {
    console.error("[user-notifications] failed to load friend recipients:", err?.message || err, {
      ...trace,
      ownerUserId,
      entityId: sosId,
    });
    return { ok: true, recipients: [], push: { attempted: false, error: "friend_lookup_failed" } };
  }

  logNotificationTrace("friend_terminal_recipients_loaded", {
    ...trace,
    ownerUserId,
    entityId: sosId,
    recipientCount: friendUserIds.length,
  });

  if (friendUserIds.length === 0) {
    return {
      ok: true,
      recipients: [],
      push: { attempted: false, reason: "no_friend_recipients" },
    };
  }

  let tokens = [];
  try {
    const tokensResult = await pool.query(
      `
      SELECT DISTINCT fcm_token
      FROM devices
      WHERE user_id = ANY($1::bigint[])
        AND fcm_token IS NOT NULL
      `,
      [friendUserIds]
    );
    tokens = tokensResult.rows.map((row) => row.fcm_token).filter(Boolean);
  } catch (err) {
    console.error("[user-notifications] failed to load friend device tokens:", err?.message || err, {
      ...trace,
      ownerUserId,
      entityId: sosId,
      recipientCount: friendUserIds.length,
    });
    return {
      ok: true,
      recipients: friendUserIds,
      push: { attempted: false, error: "token_lookup_failed" },
    };
  }

  logNotificationTrace("friend_terminal_tokens_loaded", {
    ...trace,
    ownerUserId,
    entityId: sosId,
    recipientCount: friendUserIds.length,
    tokenCount: tokens.length,
  });

  const title = buildFriendSosTerminalNotificationTitle(terminalOutcome);
  const body = buildFriendSosTerminalNotificationBody(terminalOutcome, senderName);
  const pushResult = await sendMulticastWithCleanup({
    tokens,
    title,
    body,
    data: {
      type: "sos_update",
      sos_id: sosId,
      status: terminalOutcome,
      terminal_outcome: terminalOutcome,
      fallback_route: fallbackRoute,
      sender_user_id: ownerUserId,
      sender_name: senderName,
      latitude: input?.latitude,
      longitude: input?.longitude,
      address:
        typeof input?.address === "string" && input.address.trim() ? input.address.trim() : null,
      category:
        typeof input?.category === "string" && input.category.trim() ? input.category.trim() : null,
      title,
      body,
    },
    trace: {
      ...trace,
      entityId: sosId,
      recipientUserId: ownerUserId,
      notificationType: "sos_update",
      status: terminalOutcome,
    },
  });

  return {
    ok: true,
    recipients: friendUserIds,
    push: pushResult.push,
  };
}
