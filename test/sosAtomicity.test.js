import test from "node:test";
import assert from "node:assert/strict";
import * as sosLiveOps from "../src/services/sosLiveOps.js";
import { SosRecord } from "../src/models/Reduced.js";
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
  const threadId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const sosId = new mongoose.Types.ObjectId();
  const latest = { latitude: 1.25, longitude: 2.5, address: "Beacon Hall" };
  stub(t, mongoose, "startSession", async () => session);
  stub(t, SosRecord, "findOne", (filter) => {
    assert.deepEqual(filter, { thread_id: threadId, record_type: "event" });
    return { sort() { return this; }, session(value) { assert.equal(value, session); return this; }, lean: async () => latest };
  });
  stub(t, SosRecord, "updateOne", async (filter, update, options) => {
    calls.push("thread");
    assert.deepEqual(filter, { _id: threadId, record_type: "case", latest_status: "active" });
    assert.equal(update.$set.latest_status, "resolved");
    assert.equal(options.session, session);
    return { modifiedCount: 1 };
  });
  stub(t, SosRecord, "create", async (documents, options) => {
    calls.push("event");
    assert.equal(options.session, session);
    assert.equal(documents[0].record_type, "event");
    assert.equal(documents[0].sos_id.toString(), sosId.toString());
    assert.equal(documents[0].latitude, latest.latitude);
    assert.equal(documents[0].longitude, latest.longitude);
    return documents;
  });

  const createdAt = new Date("2026-09-27T00:00:00Z");
  const event = await sosLiveOps.appendThreadStatusEvent({
    thread: { _id: threadId, user_id: userId, emergency_category: "medical" },
    sosId: sosId.toString(),
    threadUpdates: { latest_status: "resolved", terminal_status: "safe" },
    event: { user_id: userId, status: "safe", actor_type: "user", event_type: "status_update" },
    createdAt,
  });

  assert.equal(event.record_type, "event");
  assert.deepEqual(calls, ["transaction", "thread", "event", "end"]);
});

test("appendThreadStatusEvent does not append an event when the active thread changed concurrently", async (t) => {
  const session = { withTransaction: async (work) => work(), endSession: async () => {} };
  const threadId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  let eventCreated = false;
  stub(t, mongoose, "startSession", async () => session);
  stub(t, SosRecord, "findOne", () => ({ sort() { return this; }, session() { return this; }, lean: async () => null }));
  stub(t, SosRecord, "updateOne", async () => ({ modifiedCount: 0 }));
  stub(t, SosRecord, "create", async () => { eventCreated = true; });

  await assert.rejects(
    sosLiveOps.appendThreadStatusEvent({
      thread: { _id: threadId, user_id: userId, emergency_category: "medical" },
      sosId: new mongoose.Types.ObjectId().toString(),
      threadUpdates: { latest_status: "resolved" },
      event: { user_id: userId, status: "safe", actor_type: "user", event_type: "status_update" },
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
  stub(t, SosRecord, "create", async (documents, options) => { calls.push(documents[0].record_type); assert.equal(options.session, session); return documents; });

  const rootEventId = new mongoose.Types.ObjectId();
  const threadId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  await sosLiveOps.createSosThreadWithRootEvent({
    event: { _id: rootEventId, sos_id: rootEventId, thread_id: threadId, user_id: userId, status: "active" },
    thread: { _id: threadId, root_event_id: rootEventId, user_id: userId, latest_status: "active" },
  });

  assert.deepEqual(calls, ["transaction", "event", "case", "end"]);
});
