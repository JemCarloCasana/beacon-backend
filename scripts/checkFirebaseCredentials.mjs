import "dotenv/config";
import admin from "../src/firebaseAdmin.js";
try {
  await admin.app().options.credential.getAccessToken();
  try { await admin.auth().getUser("__beacon_security_credential_probe__"); }
  catch (error) { if (error.code !== "auth/user-not-found") throw error; }
  console.log(JSON.stringify({ credentials_valid: true, authentication_read_verified: true }));
} catch (error) {
  console.error(JSON.stringify({ credentials_valid: false, code: error.code ?? "credential_rejected" }));
  process.exitCode = 1;
}
