const SENSITIVE_KEYS = new Set(
  [
    "password",
    "password_hash",
    "passwordhash",
    "token",
    "idtoken",
    "accesstoken",
    "refreshtoken",
    "secret",
    "jwtsecret",
    "sessionsecret",
    "authorization",
    "cookie",
    "set-cookie",
    "connectionstring",
    "database_url",
    "mongodb_uri",
    "serviceaccount",
    "privatekey",
  ].map((key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, ""))
);

const MAX_DEPTH = 3;
const MAX_ARRAY_ITEMS = 20;

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SENSITIVE_KEYS.has(normalized)) {
    return true;
  }
  for (const sensitive of SENSITIVE_KEYS) {
    if (normalized.includes(sensitive)) {
      return true;
    }
  }
  return false;
}

export function redactAuditValue(value, depth = 0) {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => redactAuditValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    const redacted = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = isSensitiveKey(key) ? "[redacted]" : redactAuditValue(entry, depth + 1);
    }
    return redacted;
  }
  return "[unlogged]";
}

function toActorId(actor) {
  if (actor == null) {
    return null;
  }
  if (typeof actor === "number" || typeof actor === "string") {
    return actor;
  }
  const id = actor.adminId ?? actor.id ?? actor.uid ?? null;
  return typeof id === "number" || typeof id === "string" ? id : null;
}

export function auditLog({ action, actor = null, target = null, outcome = null, details = null }) {
  const entry = {
    ts: new Date().toISOString(),
    action: String(action ?? "unknown"),
    actor: toActorId(actor),
    target: target ?? null,
    outcome: outcome ?? null,
  };
  if (details != null && typeof details === "object") {
    entry.details = redactAuditValue(details);
  }
  console.log(JSON.stringify({ audit: entry }));
}
