import mongoose from "mongoose";

function redactMongoError(err) {
  const code = err?.code ?? err?.codeName ?? null;
  const name = err?.name ?? "MongoError";
  return { name, code };
}

export function getMongoUri() {
  return process.env.MONGODB_URI ?? "";
}

export function isMongoConnected() {
  return mongoose.connection?.readyState === 1;
}

export async function connectMongo({ dbName } = {}) {
  if (isMongoConnected()) {
    return mongoose.connection;
  }

  const uri = getMongoUri();
  if (!uri) {
    throw new Error("MONGODB_URI is not configured");
  }

  mongoose.set("strictQuery", true);
  const selectedDbName = dbName || process.env.MONGODB_DB_NAME || process.env.MONGO_DISPOSABLE_DB_NAME || undefined;

  try {
    await mongoose.connect(uri, {
      ...(selectedDbName ? { dbName: selectedDbName } : {}),
      autoIndex: true,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
    });
  } catch (err) {
    const redacted = redactMongoError(err);
    console.error("MongoDB connection failed", redacted);
    throw new Error("MongoDB connection failed");
  }

  mongoose.connection.on("error", (err) => {
    console.error("MongoDB connection error", redactMongoError(err));
  });

  return mongoose.connection;
}

export async function disconnectMongo() {
  if (mongoose.connection?.readyState !== 0) {
    await mongoose.disconnect();
  }
}

export { mongoose };
