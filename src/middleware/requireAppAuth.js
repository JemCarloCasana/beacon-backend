import { requireAuth } from "./requireAuth.js";
import { upsertProfileFromToken } from "../services/userProfiles.js";

export async function requireAppAuth(req, res, next) {
  return requireAuth(req, res, async () => {
    try {
      const profile = await upsertProfileFromToken(req.auth.claims);
      req.userProfile = profile;
      return next();
    } catch (err) {
      console.error("App auth bootstrap error:", err?.message || err);
      return res.status(500).json({ message: "Unable to initialize user profile" });
    }
  });
}
