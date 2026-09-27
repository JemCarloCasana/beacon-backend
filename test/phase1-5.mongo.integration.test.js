// Explicit opt-in: creates and removes a uniquely named test database, never the URI's database.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { Broadcast } from "../src/models/Broadcast.js";
import { BroadcastDelivery } from "../src/models/BroadcastDelivery.js";
import { AdminNotification } from "../src/models/AdminNotification.js";
import { UserNotification } from "../src/models/UserNotification.js";
import { ReportRun } from "../src/models/ReportRun.js";
import { Counter } from "../src/models/Counter.js";
import { EmergencyContact, UserProfile } from "../src/models/Remaining.js";
import { sendBroadcastByPublicId } from "../src/services/broadcastSend.js";
import { upsertMany, advanceCounter, compareImportedDocuments } from "./mongoImportHelpers.js";

test("isolated Atlas migration and transaction checks", { skip: process.env.BEACON_RUN_MONGO_TESTS !== "1" }, async (t) => {
  const dbName = `beacon_fix_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  let owned = false;
  try {
    try {
      await mongoose.connect(process.env.MONGODB_URI, { dbName, serverSelectionTimeoutMS: 10000, autoCreate: false, autoIndex: false });
    } catch {
      throw new Error("Unable to connect to isolated Atlas test database");
    }
    assert.equal(mongoose.connection.name, dbName);
    assert.equal((await mongoose.connection.db.listCollections().toArray()).length, 0);
    owned = true;
    console.log(`Test database: ${dbName}`);
    for (const model of [Broadcast, BroadcastDelivery, AdminNotification, UserNotification, ReportRun, Counter, UserProfile, EmergencyContact]) {
      await model.createCollection();
      await model.createIndexes();
    }
    await UserProfile.create([
      { public_id: 1, firebase_uid: "integration-user-1", full_name: "Integration One", email: "integration-one@example.test", beacon_code: "BCN-TEST01" },
      { public_id: 2, firebase_uid: "integration-user-2", full_name: "Integration Two", email: "integration-two@example.test", beacon_code: "BCN-TEST02" },
    ]);
    const draft = { public_id: 7, title: "Synthetic test", body: "Synthetic test", severity: "warning", audience_type: "all", created_by_admin_id: 1, sent_at: null, created_at: new Date(0), updated_at: new Date(0) };

    await t.test("import reruns preserve fields and enforce unique indexes", async () => {
      await upsertMany(Broadcast, [draft], ["public_id"]);
      await upsertMany(Broadcast, [draft], ["public_id"]);
      assert.equal(await Broadcast.countDocuments(), 1);
      assert.deepEqual(compareImportedDocuments([draft], await Broadcast.find({}).lean(), ["public_id"]), []);
      await assert.rejects(Broadcast.create(draft), (err) => err.code === 11000);
      await advanceCounter("broadcasts", 7);
      const ids = await Promise.all(Array.from({ length: 12 }, () => Counter.nextPublicId("broadcasts")));
      assert.equal(new Set(ids).size, 12);
      assert.equal(await advanceCounter("broadcasts", 1), Math.max(...ids));
    });

    await t.test("concurrent sends yield one send and no duplicate deliveries", async () => {
      const outcomes = await Promise.all([sendBroadcastByPublicId(7), sendBroadcastByPublicId(7)]);
      assert.deepEqual(outcomes.map((o) => o.status).sort(), ["already_sent", "sent"]);
      assert.equal(await BroadcastDelivery.countDocuments({ broadcast_public_id: 7 }), 2);
    });

    await t.test("ack pipeline preserves time and scopes recipients", async () => {
      const filter = { broadcast_public_id: 7, recipient_user_id: 1 };
      const update = [{ $set: { acknowledged_at: { $ifNull: ["$acknowledged_at", "$$NOW"] } } }];
      const options = { returnDocument: "after", updatePipeline: true };
      const first = await BroadcastDelivery.findOneAndUpdate(filter, update, options).lean();
      const second = await BroadcastDelivery.findOneAndUpdate(filter, update, options).lean();
      assert.ok(first?.acknowledged_at);
      assert.equal(first.acknowledged_at.getTime(), second.acknowledged_at.getTime());
      assert.equal(await BroadcastDelivery.findOneAndUpdate({ ...filter, recipient_user_id: 999 }, update, options), null);
    });

    await t.test("delivery failure rolls back the send marker", async () => {
      const fresh = await Broadcast.create({ ...draft, public_id: 8 });
      // Existing recipient deliberately causes a real unique-index failure inside the transaction.
      await BroadcastDelivery.create({ broadcast_id: fresh._id, broadcast_public_id: 8, recipient_user_id: 1 });
      await assert.rejects(sendBroadcastByPublicId(8));
      assert.equal((await Broadcast.findOne({ public_id: 8 }).lean()).sent_at, null);
      assert.equal(await BroadcastDelivery.countDocuments({ broadcast_public_id: 8 }), 1);
    });

    await t.test("localhost HTTP routes use Mongo-backed profiles and contacts", async () => {
      const { app } = await import("../server.js");
      const { setVerifyIdTokenForTests } = await import("../src/middleware/requireAuth.js");
      setVerifyIdTokenForTests(async (token) => {
        assert.equal(token, "isolated-mongo-smoke-token");
        return { uid: "integration-user-1", email: "integration-one@example.test" };
      });
      const server = await new Promise((resolve) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
      });
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const headers = {
        Authorization: "Bearer isolated-mongo-smoke-token",
        "Content-Type": "application/json",
      };
      try {
        const profile = await fetch(`${baseUrl}/me`, { headers });
        assert.equal(profile.status, 200);
        assert.equal((await profile.json()).id, 1);

        const contact = await fetch(`${baseUrl}/contacts`, {
          method: "POST",
          headers,
          body: JSON.stringify({ contact_name: "Synthetic Contact", phone_number: "09171234567" }),
        });
        assert.equal(contact.status, 201);
        assert.deepEqual(
          (({ id, contact_name, phone_number, relation, is_primary }) => ({ id, contact_name, phone_number, relation, is_primary }))(await contact.json()),
          { id: 1, contact_name: "Synthetic Contact", phone_number: "+639171234567", relation: null, is_primary: false },
        );
      } finally {
        setVerifyIdTokenForTests(null);
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });
  } finally {
    if (owned && mongoose.connection.name === dbName && /^beacon_fix_[a-f0-9]{24}$/.test(dbName)) {
      await mongoose.connection.db.dropDatabase();
      console.log("Isolated test database removed");
    }
    await mongoose.disconnect();
  }
});
