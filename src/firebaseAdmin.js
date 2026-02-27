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

export default admin;
