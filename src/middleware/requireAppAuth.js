import { requireAuth } from "./requireAuth.js";
import { refreshProfileFromToken } from "../services/userProfiles.js";

export async function requireAppAuth(req, res, next) {
  return requireAuth(req, res, async () => {
    try {
      const profile = await refreshProfileFromToken(req.auth.claims);
      if (!profile) {
        return res.status(403).json({ code: "PROFILE_SETUP_REQUIRED", message: "Complete your Beacon profile in Dagupan City to continue." });
      }
      req.userProfile = profile;
      return next();
    } catch (err) {
      if (err?.code === "ACCOUNT_DEACTIVATED") return res.status(403).json({ code: err.code, message: err.message });
      console.error("App auth bootstrap error:", err?.message || err);
      return res.status(500).json({ message: "Unable to initialize user profile" });
    }
  });
}
