import admin from "../firebaseAdmin.js";
import { recordAuthFailure, recordAuthSuccess } from "../utils/authMetrics.js";

let customVerifyIdToken = null;

export function setVerifyIdTokenForTests(verifyFn) {
  customVerifyIdToken = verifyFn;
}

export async function requireAuth(req, res, next) {
  const startedAt = Date.now();
  try {
    const header = req.headers.authorization || "";
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(header.trim());
    const token = bearerMatch ? bearerMatch[1].trim() : null;

    if (!token) {
      recordAuthFailure("missing_bearer");
      return res.status(401).json({ message: "Missing Bearer token" });
    }

    const checkRevoked = process.env.NODE_ENV === "production" || String(process.env.FIREBASE_CHECK_REVOKED || "").toLowerCase() === "true";
    const decoded = customVerifyIdToken
      ? await customVerifyIdToken(token, checkRevoked)
      : await admin.auth().verifyIdToken(token, checkRevoked);

    req.auth = {
      uid: decoded.uid,
      email: decoded.email || null,
      role: typeof decoded.role === "string" ? decoded.role : null,
      claims: decoded,
    };

    recordAuthSuccess(Date.now() - startedAt);
    return next();
  } catch (err) {
    const code = err?.code ?? "unknown";
    if (code === "auth/user-disabled") return res.status(403).json({ code: "ACCOUNT_DEACTIVATED", message: "Account is deactivated" });
    const invalidCodes = new Set(["auth/argument-error", "auth/invalid-id-token", "auth/id-token-expired", "auth/id-token-revoked", "auth/user-not-found"]);
    if (!invalidCodes.has(code)) {
      console.warn("Auth provider unavailable", { code });
      return res.status(503).json({ code: "AUTH_PROVIDER_UNAVAILABLE", message: "Authentication is temporarily unavailable. Please retry." });
    }

    recordAuthFailure("invalid_or_expired");
    const errCode = err?.code || "unknown";
    console.warn("Auth verification failed", { code: errCode });
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}
