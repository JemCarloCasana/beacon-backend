import assert from "node:assert/strict";
import admin from "firebase-admin";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "Run through the Firestore emulator; never against production");
const projectId = "demo-beacon-security";
const app = admin.initializeApp({ projectId });
const db = app.firestore();
const paths = ["sos_sessions/case", "sos_sessions/case/locations/point", "users/phone-mirror"];
const clientToken = `${Buffer.from(JSON.stringify({alg:"none",typ:"JWT"})).toString("base64url")}.${Buffer.from(JSON.stringify({sub:"signed-in-client",user_id:"signed-in-client",aud:projectId,iss:`https://securetoken.google.com/${projectId}`,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,firebase:{sign_in_provider:"password"}})).toString("base64url")}.`;
for (const path of paths) {
  await db.doc(path).set({ backend_owned: true });
  assert.equal((await db.doc(path).get()).data().backend_owned, true);
  const url = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${projectId}/databases/(default)/documents/${path}`;
  for (const token of [null, clientToken]) {
    const headers={"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})};
    assert.equal((await fetch(url,{headers})).status,403,`client read denied: ${path}`);
    assert.equal((await fetch(url,{method:"PATCH",headers,body:JSON.stringify({fields:{client_owned:{booleanValue:true}}})})).status,403,`client write denied: ${path}`);
  }
}
console.log("Firestore client reads/writes denied; backend reads/writes succeed (3 paths, authenticated and anonymous clients).");
await app.delete();
