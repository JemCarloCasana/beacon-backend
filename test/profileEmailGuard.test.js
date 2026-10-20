import test from "node:test";
import assert from "node:assert/strict";
import { ReducedUserProfile as UserProfile } from "../src/models/Reduced.js";
import { refreshProfileFromToken, bootstrapProfile } from "../src/services/userProfiles.js";

const inside = { latitude: 16.043502806506392, longitude: 120.3354064229617 };

function existingProfile(overrides = {}) {
  return new UserProfile({
    firebase_uid: "uid-1",
    email: "real@example.com",
    full_name: "Real Name",
    role: "citizen",
    beacon_code: "BCN-ABC123",
    ...overrides,
  });
}

test("a token without an email claim does not overwrite the stored address", async (t) => {
  const profile = existingProfile();
  t.mock.method(profile, "save", async () => profile);
  t.mock.method(UserProfile, "findOne", async () => profile);

  await refreshProfileFromToken({ uid: "uid-1" });

  assert.equal(profile.email, "real@example.com", "the stored address is left alone");
});

test("a token with an email claim updates the stored address", async (t) => {
  const profile = existingProfile();
  t.mock.method(profile, "save", async () => profile);
  t.mock.method(UserProfile, "findOne", async () => profile);

  await refreshProfileFromToken({ uid: "uid-1", email: "New@Example.com" });

  assert.equal(profile.email, "new@example.com", "the stored address follows the token");
});

test("re-bootstrapping an existing profile does not overwrite the stored address", async (t) => {
  const profile = existingProfile();
  t.mock.method(profile, "save", async () => profile);
  t.mock.method(UserProfile, "findOne", async () => profile);

  await bootstrapProfile({
    uid: "uid-1",
    email: undefined,
    fullName: "Real Name",
    phoneNumber: "09170000000",
    role: "citizen",
    ...inside,
  });

  assert.equal(profile.email, "real@example.com", "the stored address is left alone");
});

test("a brand new profile still receives a synthetic address", async (t) => {
  let created = null;
  t.mock.method(UserProfile, "findOne", async () => null);
  t.mock.method(UserProfile, "create", async (values) => {
    created = values;
    return new UserProfile(values);
  });

  await bootstrapProfile({
    uid: "uid-new",
    email: undefined,
    fullName: "New User",
    phoneNumber: "09170000000",
    role: "citizen",
    ...inside,
  });

  assert.equal(created.email, "uid-new@firebase.local", "a new profile still gets a usable address");
});
