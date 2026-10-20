import test from "node:test";
import assert from "node:assert/strict";
import { assertFirebaseReady } from "../src/firebaseAdmin.js";

function fakeApp(getAccessToken) {
  return { options: { credential: { getAccessToken } } };
}

test("a credential that returns an access token is ready", async () => {
  const app = fakeApp(async () => ({ access_token: "token" }));
  assert.equal(await assertFirebaseReady(app), true);
});

test("a rejected credential fails with a usable message", async () => {
  const app = fakeApp(async () => {
    throw new Error("invalid_grant: Invalid JWT Signature.");
  });
  await assert.rejects(assertFirebaseReady(app), /not usable/);
});

test("a credential that returns no token fails", async () => {
  const app = fakeApp(async () => ({}));
  await assert.rejects(assertFirebaseReady(app), /no access token/);
});
