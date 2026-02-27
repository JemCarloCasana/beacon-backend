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

    const checkRevoked = String(process.env.FIREBASE_CHECK_REVOKED || "").toLowerCase() === "true";
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
    next();
  } catch (err) {
    if (err?.code === "ENOENT") {
      console.error("Auth credential configuration error:", err?.message || err);
      return res.status(500).json({ message: "Auth provider is misconfigured on server" });
    }

    recordAuthFailure("invalid_or_expired");
    const errCode = err?.code || "unknown";
    const errMessage = err?.message || "verification_error";
    console.warn("Auth verification failed", {
      path: req.originalUrl || req.url,
      method: req.method,
      ip: req.ip,
      code: errCode,
      message: errMessage
    });

    const includeDebug = String(process.env.AUTH_DEBUG_ERRORS || "").toLowerCase() === "true";

    if (includeDebug) {
      return res.status(401).json({
        message: "Invalid or expired token",
        auth_error_code: errCode,
        auth_error_message: errMessage,
      });
    }

    return res.status(401).json({ message: "Invalid or expired token" });
  }
}
