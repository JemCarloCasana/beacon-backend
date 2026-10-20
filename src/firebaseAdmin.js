import admin from "firebase-admin";
import fs from "fs";

function buildCredential() {
  const inlineServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inlineServiceAccount) {
    const parsed = JSON.parse(inlineServiceAccount);
    return admin.credential.cert(parsed);
  }

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (serviceAccountPath) {
    const raw = fs.readFileSync(serviceAccountPath, "utf8");
    const parsed = JSON.parse(raw);
    return admin.credential.cert(parsed);
  }

  return admin.credential.applicationDefault();
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: buildCredential(),
    projectId: process.env.FIREBASE_PROJECT_ID || undefined
  });
}

/**
 * Proves the configured credential can actually mint an access token.
 *
 * A revoked or misconfigured key otherwise boots cleanly and then fails every
 * app request with 503, which is invisible until a user reports it.
 */
export async function assertFirebaseReady(app = admin.app()) {
  try {
    const token = await app.options.credential.getAccessToken();
    if (!token?.access_token) {
      throw new Error("Firebase credential returned no access token");
    }
    return true;
  } catch (error) {
    throw new Error(`Firebase credential is not usable: ${error?.message ?? String(error)}`);
  }
}

export default admin;
