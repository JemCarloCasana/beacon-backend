import "dotenv/config";
import dns from "node:dns/promises";
import { pathToFileURL } from "node:url";
import { connectMongo, disconnectMongo, getMongoUri, mongoose } from "../src/mongo.js";

const DISPOSABLE_NAME = process.env.MONGO_DISPOSABLE_DB_NAME || "";
const FORBIDDEN_NAMES = new Set(["beacon-admin", "production", "prod"]);

function targetFromUri(uri) {
  const parsed = new URL(uri);
  return {
    host: parsed.hostname,
    database: decodeURIComponent(parsed.pathname.slice(1)),
    srv: parsed.protocol === "mongodb+srv:",
  };
}

function assertDisposable(database) {
  if (!DISPOSABLE_NAME) throw new Error("MONGO_DISPOSABLE_DB_NAME is required");
  if (database && database !== DISPOSABLE_NAME) {
    throw new Error(`MONGODB_URI database "${database}" does not match MONGO_DISPOSABLE_DB_NAME "${DISPOSABLE_NAME}"`);
  }
  const normalized = (database || DISPOSABLE_NAME).trim().toLowerCase();
  if (FORBIDDEN_NAMES.has(normalized) || !/(test|phase|sandbox)/i.test(normalized)) {
    throw new Error("MONGODB_URI must target a disposable test database");
  }
}

export async function runPreflight({ disconnect = true } = {}) {
  const uri = getMongoUri();
  if (!uri) throw new Error("MONGODB_URI is not configured");
  const target = targetFromUri(uri);
  assertDisposable(target.database);
  target.database = target.database || DISPOSABLE_NAME;
  if (target.srv) {
    await dns.resolveSrv(`_mongodb._tcp.${target.host}`);
  } else {
    await dns.lookup(target.host);
  }
  await connectMongo({ dbName: target.database });

  const collectionName = `_beacon_preflight_${Date.now()}`;
  try {
    const db = mongoose.connection.db;
    await db.command({ ping: 1 });
    const collection = db.collection(collectionName);
    await collection.createIndex({ marker: 1 }, { unique: true });
    await collection.insertOne({ marker: "ok" });
    await collection.deleteOne({ marker: "ok" });
    await collection.drop();
  } finally {
    if (disconnect) await disconnectMongo();
  }

  return { host: target.host, database: target.database };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const target = await runPreflight();
    console.log(`MongoDB preflight passed host=${target.host} database=${target.database}`);
  } catch (error) {
    console.error(`MongoDB preflight failed: ${error.message}`);
    process.exitCode = 1;
  }
}
