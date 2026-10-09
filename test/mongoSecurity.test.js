import test from "node:test";
import assert from "node:assert/strict";
import { connectMongo, mongoose } from "../src/mongo.js";
test("production refuses an implicit database and unsafe TLS/test overrides",async t=>{
  const saved={...process.env}; t.after(()=>{process.env=saved;});
  process.env.NODE_ENV="production"; process.env.MONGODB_URI="mongodb://user:secret@localhost/";
  delete process.env.MONGODB_DB_NAME;
  await assert.rejects(connectMongo(),/MONGODB_DB_NAME/);
  process.env.MONGODB_DB_NAME="beacon";
  for(const suffix of ["?tlsAllowInvalidCertificates=true","?tlsAllowInvalidHostnames=true","?tlsInsecure=true","?tls=false","?ssl=false"]) {
    process.env.MONGODB_URI=`mongodb://user:secret@localhost/${suffix}`;
    await assert.rejects(connectMongo(),/TLS/);
  }
  process.env.MONGODB_URI="mongodb://user:secret@localhost/";
  process.env.MONGO_DISPOSABLE_DB_NAME="beacon_test_123";
  await assert.rejects(connectMongo(),/disposable/i);
});
