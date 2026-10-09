import "dotenv/config";
import { connectMongo, disconnectMongo } from "../src/mongo.js";
import { AdminRecord, SosRecord, ReducedUserProfile } from "../src/models/Reduced.js";
import admin from "../src/firebaseAdmin.js";

const apply = process.argv.includes("--apply");
if (!process.env.MONGODB_DB_NAME) throw new Error("Inventory and explicitly configure MONGODB_DB_NAME first");
let accounts = 0, locations = 0, unmatched = 0;
try {
  await connectMongo({ autoIndex: false, autoCreate: false });
  accounts = await AdminRecord.countDocuments({ record_type: "account", token_version: { $exists: false } });
  const cases = await SosRecord.find({ record_type: "case", location_updated_at: { $exists: false } }).lean();
  for (const thread of cases) {
    const owner = await ReducedUserProfile.findById(thread.user_id).lean();
    if (!owner?.firebase_uid) { unmatched++; continue; }
    const sessions = await admin.firestore().collection("sos_sessions").where("backendSosId", "==", thread.root_event_id.toString()).get();
    const points = sessions.docs.filter(doc => doc.data().userId === owner.firebase_uid).flatMap(doc => doc.data().locations ?? []).map(entry => ({ latitude: entry.location?.latitude, longitude: entry.location?.longitude, time: entry.timestamp?.toDate?.() ?? new Date(entry.timestamp) })).filter(point => Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180 && Number.isFinite(point.time.getTime()) && point.time <= new Date());
    points.sort((a,b) => b.time - a.time);
    const point = points[0];
    if (!point) { unmatched++; continue; }
    locations++;
    if (apply) await SosRecord.updateOne({ _id: thread._id, record_type: "case", user_id: owner._id, location_updated_at: { $exists: false } }, { $set: { latitude: point.latitude, longitude: point.longitude, location_updated_at: point.time } });
  }
  if (apply) await AdminRecord.updateMany({ record_type: "account", token_version: { $exists: false } }, { $set: { token_version: 0 } });
  console.log(JSON.stringify({ dry_run: !apply, database: process.env.MONGODB_DB_NAME, accounts_to_backfill: accounts, matched_legacy_locations: locations, unmatched_cases: unmatched }));
} catch (error) { console.error(JSON.stringify({ failed: true, code: error.code ?? null, name: error.name })); process.exitCode = 1; }
finally { await disconnectMongo(); }
