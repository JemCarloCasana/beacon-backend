import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

// A credential that is unmistakably ours, so the app that ends up holding it
// can be identified no matter which module initialised it.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const probeEmail = "probe@example.iam.gserviceaccount.com";
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: "service_account",
  project_id: "beacon-probe",
  private_key_id: "probe-key-id",
  private_key: privateKey,
  client_email: probeEmail,
  client_id: "000000000000000000000",
});

// Import the push module FIRST. If it can stand up its own Firebase app, it
// wins the race to be the default app and the shared credential is bypassed.
await import("../src/services/fcm.js");
const { default: admin } = await import("../src/firebaseAdmin.js");

test("importing the push module does not create a second Firebase app", () => {
  assert.equal(admin.apps.length, 1, "exactly one Firebase app is registered");
});

test("the registered app uses the shared credential, not a standalone one", () => {
  const credential = admin.apps[0].options.credential;
  assert.equal(
    credential.clientEmail,
    probeEmail,
    "the default app holds the credential configured for the shared app"
  );
});
