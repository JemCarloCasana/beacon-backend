import "dotenv/config";
import { MongoClient } from "mongodb";
const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
try {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME || undefined);
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  const counts = {};
  for (const { name } of collections) counts[name] = await db.collection(name).estimatedDocumentCount();
  const auth = await db.command({ connectionStatus: 1, showPrivileges: true });
  console.log(JSON.stringify({ database: db.databaseName, tls: client.options.tls, collections: counts, roles: auth.authInfo.authenticatedUserRoles }, null, 2));
} catch (error) { console.error(JSON.stringify({ failed: true, code: error.code ?? null, name: error.name })); process.exitCode = 1; }
finally { await client.close(); }
