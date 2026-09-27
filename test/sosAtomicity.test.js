import test from "node:test";
import assert from "node:assert/strict";
import * as sosLiveOps from "../src/services/sosLiveOps.js";
import { Counter } from "../src/models/Counter.js";
import { SosEvent, SosThread } from "../src/models/Remaining.js";
import { mongoose } from "../src/mongo.js";

function stub(t, target, key, replacement) {
  const original = target[key];
  target[key] = replacement;
  t.after(() => { target[key] = original; });
}

test("appendThreadStatusEvent changes the thread and appends its event in one Mongo transaction", async (t) => {
  assert.equal(typeof sosLiveOps.appendThreadStatusEvent, "function");

  const calls = [];
  const session = {
    async withTransaction(work) { calls.push("transaction"); return work(); },
    async endSession() { calls.push("end"); },
  };
  const latest = { latitude: 1.25, longitude: 2.5, address: "Beacon Hall" };
  stub(t, mongoose, "startSession", async () => session);
  stub(t, Counter, "nextPublicId", async (key) => { assert.equal(key, "sos_events"); return 81; });
  stub(t, SosEvent, "findOne", (filter) => {
    assert.deepEqual(filter, { thread_id: 7 });
    return { sort() { return this; }, session(value) { assert.equal(value, session); return this; }, lean: async () => latest };
  });
  stub(t, SosThread, "updateOne", async (filter, update, options) => {
    calls.push("thread");
    assert.deepEqual(filter, { public_id: 7, latest_status: "active" });
    assert.equal(update.$set.latest_status, "resolved");
    assert.equal(options.session, session);
    return { modifiedCount: 1 };
  });
  stub(t, SosEvent, "create", async (documents, options) => {
    calls.push("event");
    assert.equal(options.session, session);
    assert.equal(documents[0].public_id, 81);
    assert.equal(documents[0].latitude, latest.latitude);
    assert.equal(documents[0].longitude, latest.longitude);
    return documents;
  });

  const createdAt = new Date("2026-09-27T00:00:00Z");
  const event = await sosLiveOps.appendThreadStatusEvent({
    thread: { public_id: 7, user_id: 3, emergency_category: "medical" },
    sosId: 42,
    threadUpdates: { latest_status: "resolved", terminal_status: "safe" },
    event: { user_id: 3, status: "safe", actor_type: "user", event_type: "status_update" },
    createdAt,
  });

  assert.equal(event.public_id, 81);
  assert.deepEqual(calls, ["transaction", "thread", "event", "end"]);
});

test("appendThreadStatusEvent does not append an event when the active thread changed concurrently", async (t) => {
  const session = { withTransaction: async (work) => work(), endSession: async () => {} };
  let eventCreated = false;
  stub(t, mongoose, "startSession", async () => session);
  stub(t, Counter, "nextPublicId", async () => 82);
  stub(t, SosEvent, "findOne", () => ({ sort() { return this; }, session() { return this; }, lean: async () => null }));
  stub(t, SosThread, "updateOne", async () => ({ modifiedCount: 0 }));
  stub(t, SosEvent, "create", async () => { eventCreated = true; });

  await assert.rejects(
    sosLiveOps.appendThreadStatusEvent({
      thread: { public_id: 7, user_id: 3, emergency_category: "medical" },
      sosId: 42,
      threadUpdates: { latest_status: "resolved" },
      event: { user_id: 3, status: "safe", actor_type: "user", event_type: "status_update" },
    }),
    (error) => error.statusCode === 409
  );
  assert.equal(eventCreated, false);
});

test("createSosThreadWithRootEvent creates the root event and thread in one Mongo transaction", async (t) => {
  assert.equal(typeof sosLiveOps.createSosThreadWithRootEvent, "function");
  const calls = [];
  const session = {
    async withTransaction(work) { calls.push("transaction"); return work(); },
    async endSession() { calls.push("end"); },
  };
  stub(t, mongoose, "startSession", async () => session);
  stub(t, SosEvent, "create", async (documents, options) => { calls.push("event"); assert.equal(options.session, session); return documents; });
  stub(t, SosThread, "create", async (documents, options) => { calls.push("thread"); assert.equal(options.session, session); return documents; });

  await sosLiveOps.createSosThreadWithRootEvent({
    event: { public_id: 81, sos_id: 81, thread_id: 91, user_id: 3, status: "active" },
    thread: { public_id: 91, root_event_id: 81, user_id: 3, latest_status: "active" },
  });

  assert.deepEqual(calls, ["transaction", "event", "thread", "end"]);
});
