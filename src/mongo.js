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

/**
 * Runs a connection attempt with exponential backoff.
 *
 * A cold container must survive a database that is not accepting connections
 * yet (a paused Atlas cluster, a slow first dial) instead of exiting and
 * crash-looping.
 */
export async function connectWithRetry(connectFn, {
  attempts = Number(process.env.MONGO_CONNECT_MAX_ATTEMPTS || 20),
  baseDelayMs = Number(process.env.MONGO_CONNECT_BASE_DELAY_MS || 1000),
  maxDelayMs = 15_000,
  logger = console,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await connectFn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      logger.warn(`MongoDB connect attempt ${attempt}/${attempts} failed (${error?.name ?? "Error"}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

export async function connectMongo({ dbName, autoIndex = true, autoCreate = true } = {}) {
  const uri = getMongoUri();
  if (!uri) {
    throw new Error("MONGODB_URI is not configured");
  }

  mongoose.set("strictQuery", true);
  const selectedDbName = dbName || process.env.MONGODB_DB_NAME || process.env.MONGO_DISPOSABLE_DB_NAME || undefined;
  const production = process.env.NODE_ENV === "production";
  if (production) {
    if (!process.env.MONGODB_DB_NAME?.trim()) throw new Error("MONGODB_DB_NAME is required in production");
    if (process.env.MONGO_DISPOSABLE_DB_NAME || (dbName && dbName !== process.env.MONGODB_DB_NAME)) throw new Error("Production refuses disposable database overrides");
    const options = new URL(uri).searchParams;
    for (const [key, value] of options) {
      if ((["tlsallowinvalidcertificates", "tlsallowinvalidhostnames", "tlsinsecure"].includes(key.toLowerCase()) && value.toLowerCase() !== "false") || (["tls", "ssl"].includes(key.toLowerCase()) && value.toLowerCase() !== "true")) throw new Error("Production requires verified TLS");
    }
  }
  if (isMongoConnected()) return mongoose.connection;

  try {
    await connectWithRetry(() => mongoose.connect(uri, {
      ...(selectedDbName ? { dbName: selectedDbName } : {}),
      ...(production ? { tls: true, tlsAllowInvalidCertificates: false, tlsAllowInvalidHostnames: false } : {}),
      autoIndex,
      autoCreate,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 10_000),
      connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 10_000),
    }));
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
