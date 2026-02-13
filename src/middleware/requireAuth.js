import admin from "../firebaseAdmin.js";

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) return res.status(401).json({ message: "Missing Bearer token" });

    const decoded = await admin.auth().verifyIdToken(token);

    req.auth = {
      uid: decoded.uid,
      email: decoded.email || null,
    };

    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}
