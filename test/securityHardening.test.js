import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
process.env.ADMIN_JWT_SECRET = "security-regression-secret";
const { AdminRecord, ReducedUserProfile: UserProfile } = await import("../src/models/Reduced.js");
const { requireAdminAuth } = await import("../src/middleware/adminAuth.js");
const { default: authRouter, resolveAdminJwtTtl } = await import("../src/routes/adminAuthRoutes.js");
const { requireAppAuth } = await import("../src/middleware/requireAppAuth.js");
const { setVerifyIdTokenForTests, requireAuth } = await import("../src/middleware/requireAuth.js");
const { bootstrapProfile } = await import("../src/services/userProfiles.js");
const { default: sosRouter } = await import("../src/routes/sosRoutes.js");
const { SosRecord, FriendConnection } = await import("../src/models/Reduced.js");
const route = (path,method) => sosRouter.stack.find(layer=>layer.route?.path===path&&layer.route.methods[method])?.route.stack.at(-1).handle;
const response = () => ({ statusCode:200, status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;} });
function stub(t, model, method, value) { const original=model[method]; model[method]=value; t.after(()=>model[method]=original); }
const query = value => ({select(){return this;},sort(){return this;},lean:async()=>value});

test("public staff signup is removed", () => {
  assert.equal(authRouter.stack.some(layer=>layer.route?.path==="/admin/auth/signup"), false);
});
test("production admin sessions expire in eight hours", () => {
  assert.equal(resolveAdminJwtTtl().ttl,"8h");
});
test("legacy and invalidated admin tokens are denied", async t => {
  const id=new mongoose.Types.ObjectId();
  stub(t,AdminRecord,"findOne",()=>query({_id:id,status:"active",token_version:2}));
  for(const version of [undefined,0,1]) {
    const token=jwt.sign({adminId:id.toString(),...(version===undefined?{}:{token_version:version})},process.env.ADMIN_JWT_SECRET,{expiresIn:"8h"});
    const res=response(); let passed=false;
    await requireAdminAuth({headers:{authorization:`Bearer ${token}`}},res,()=>passed=true);
    assert.equal(res.statusCode,401); assert.equal(passed,false);
  }
});
test("deactivated profile is blocked before refreshing or bootstrapping", async t => {
  let saves=0;
  const profile={status:"deactivated",email:"original@example.com",full_name:"Original",beacon_code:"BCN-123",save:async()=>saves++};
  stub(t,UserProfile,"findOne",async()=>profile);
  setVerifyIdTokenForTests(async()=>({uid:"disabled",email:"changed@example.com"}));
  t.after(()=>setVerifyIdTokenForTests(null));
  const res=response(); let passed=false;
  await requireAppAuth({headers:{authorization:"Bearer valid"}},res,()=>passed=true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(res.statusCode,403); assert.equal(res.body.code,"ACCOUNT_DEACTIVATED"); assert.equal(passed,false);
  await assert.rejects(bootstrapProfile({uid:"disabled",email:"changed@example.com",fullName:"Changed",role:"citizen"}),error=>error.code==="ACCOUNT_DEACTIVATED");
  assert.equal(saves,0); assert.equal(profile.email,"original@example.com");
});
test("Firebase provider errors return503 without treating the token as invalid",async t=>{
  setVerifyIdTokenForTests(async()=>{throw Object.assign(new Error("provider unavailable"),{code:"auth/internal-error"});});
  t.after(()=>setVerifyIdTokenForTests(null));
  const res=response(); await requireAuth({headers:{authorization:"Bearer valid"}},res,()=>assert.fail("unauthorized"));
  assert.equal(res.statusCode,503);
});
test("live location updates reject invalid coordinates before any writes", async()=>{
  const update=route("/sos/:sosId/location","patch"); assert.equal(typeof update,"function");
  for(const body of [{},{latitude:1},{latitude:"1",longitude:2},{latitude:Infinity,longitude:2},{latitude:91,longitude:2},{latitude:1,longitude:181}]) {
    const res=response(); await update({params:{sosId:new mongoose.Types.ObjectId().toString()},body},res);
    assert.equal(res.statusCode,400);
  }
});
test("closed-case location update cannot race past closure",async t=>{
  const update=route("/sos/:sosId/location","patch"); assert.equal(typeof update,"function");
  const owner=new mongoose.Types.ObjectId(),sos=new mongoose.Types.ObjectId(),id=new mongoose.Types.ObjectId();
  stub(t,SosRecord,"findOne",()=>query({_id:id,user_id:owner,latest_status:"active",root_event_id:sos}));
  stub(t,SosRecord,"findOneAndUpdate",filter=>{assert.equal(filter.latest_status,"active"); assert.equal(filter.user_id.toString(),owner.toString()); return query(null);});
  const res=response(); await update({params:{sosId:sos.toString()},body:{latitude:15,longitude:120},userProfile:{_id:owner}},res);
  assert.equal(res.statusCode,409);
});
test("unrelated and removed friends cannot read live SOS",async t=>{
  const get=route("/sos/:sosId/live","get"); assert.equal(typeof get,"function");
  const owner=new mongoose.Types.ObjectId(),visitor=new mongoose.Types.ObjectId(),sos=new mongoose.Types.ObjectId();
  stub(t,SosRecord,"findOne",()=>query({user_id:owner,root_event_id:sos}));
  stub(t,FriendConnection,"exists",async()=>null);
  const res=response(); await get({params:{sosId:sos.toString()},userProfile:{_id:visitor}},res);
  assert.equal(res.statusCode,403);
});
test("SOS streams close without sending private data after session or permission revocation",async t=>{
  const { subscribeSse, writeSnapshotToStream, writeHeartbeat, replaySince } = await import("../src/services/sosLiveOps.js");
  const { isAdminSessionValid } = await import("../src/middleware/adminAuth.js");
  const id=new mongoose.Types.ObjectId(); let version=0, permissions=["manage_sos"],closed=false,writes=[];
  stub(t,AdminRecord,"findOne",()=>query({_id:id,status:"active",token_version:version,permissions}));
  const session={adminId:id.toString(),token_version:0,exp:Math.floor(Date.now()/1000)+100};
  const stream={write:s=>writes.push(s),end:()=>closed=true};
  const unsubscribe=subscribeSse(stream,()=>isAdminSessionValid(session,"manage_sos")); t.after(unsubscribe);
  await writeSnapshotToStream(stream,[{sos_id:"authorized"}]); assert.ok(writes.length);
  const before=writes.length; permissions=[];
  await writeSnapshotToStream(stream,[{sos_id:"private"}]); await writeHeartbeat(stream); await replaySince(0,stream);
  assert.equal(closed,true); assert.equal(writes.length,before);
  version=1; assert.equal(await isAdminSessionValid(session,"manage_sos"),false);
  session.exp=1; assert.equal(await isAdminSessionValid(session,"manage_sos"),false);
});
test("direct admin API requests with forged roles and no permissions are rejected",async t=>{
  const { app } = await import("../server.js");
  const id=new mongoose.Types.ObjectId(); let writes=0;
  stub(t,AdminRecord,"findOne",()=>query({_id:id,status:"active",token_version:0,role:"personnel",permissions:[]}));
  stub(t,AdminRecord,"create",async()=>{writes++;throw new Error("Unauthorized creation");});
  const token=jwt.sign({adminId:id.toString(),role:"admin",token_version:0},process.env.ADMIN_JWT_SECRET,{expiresIn:"8h"});
  const server=await new Promise(resolve=>{const server=app.listen(0,"127.0.0.1",()=>resolve(server));});
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    for(const path of ["/admin/incidents","/admin/incidents/111111111111111111111111","/admin/incidents/111111111111111111111111/images/222222222222222222222222","/admin/broadcasts","/admin/sos/live"]) {
      assert.equal((await fetch(base+path)).status,401);
      assert.equal((await fetch(base+path,{headers:{Authorization:`Bearer ${token}`}})).status,403);
    }
    assert.equal((await fetch(base+"/admin/auth/signup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"public@example.com",full_name:"Public Staff",password:"SecurePass1!"})})).status,404);
    assert.equal(writes,0);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
test("a competing incident update returns409 without writing a notification",async t=>{
  const { default: router }=await import("../src/routes/incidentRoutes.js");
  const { ReducedIncidentReport: Incident, Notification }=await import("../src/models/Reduced.js");
  const id=new mongoose.Types.ObjectId(); let notifications=0;
  stub(t,Incident,"findById",()=>query({_id:id,status:"pending",user_id:new mongoose.Types.ObjectId(),evidence:[]}));
  stub(t,Incident,"updateOne",async filter=>{assert.equal(filter.status,"pending");return {matchedCount:0};});
  stub(t,Notification,"create",async()=>notifications++);
  const handler=router.stack.find(layer=>layer.route?.path==="/admin/incidents/:id"&&layer.route.methods.patch).route.stack.at(-1).handle;
  const res=response(); await handler({params:{id:id.toString()},body:{status:"dispatched"},admin:{adminId:new mongoose.Types.ObjectId().toString()}},res);
  assert.equal(res.statusCode,409); assert.equal(notifications,0);
});
test("logout and password changes invalidate all devices with one atomic account write",async t=>{
  const bcrypt=(await import("bcrypt")).default;
  const id=new mongoose.Types.ObjectId(); const hash=await bcrypt.hash("OldPassword1!",4);
  stub(t,AdminRecord,"findOne",()=>query({_id:id,password_hash:hash,token_version:0}));
  const updates=[];
  stub(t,AdminRecord,"updateOne",async(filter,update)=>{updates.push({filter,update});return {matchedCount:1};});
  const req={admin:{adminId:id.toString(),token_version:0},body:{current_password:"OldPassword1!",new_password:"NewPassword1!"}};
  for (const path of ["/admin/auth/change-password","/admin/auth/logout"]) {
    const res=response(); res.end=()=>res;
    await authRouter.stack.find(layer=>layer.route?.path===path).route.stack.at(-1).handle(req,res);
    assert.equal(res.statusCode,204);
  }
  assert.equal(updates.length,2);
  assert.equal(updates[0].update.$inc.token_version,1); assert.equal(updates[0].filter.password_hash,hash);
  assert.equal(await bcrypt.compare("NewPassword1!",updates[0].update.$set.password_hash),true);
  assert.equal(updates[1].update.$inc.token_version,1);
});
test("new passwords reject more than72 UTF8 bytes before any database write",async()=>{
  const handler=authRouter.stack.find(layer=>layer.route?.path==="/admin/auth/change-password").route.stack.at(-1).handle;
  const res=response(); await handler({body:{current_password:"OldPassword1!",new_password:"Ab1!"+"é".repeat(35)}},res);
  assert.equal(res.statusCode,422); assert.match(res.body.message,/72 bytes/);
});
test("deactivated recipients get no new operational notification or push",async t=>{
  const {notifyUserLifecycleEvent}=await import("../src/services/userNotifications.js");
  const {Notification}=await import("../src/models/Reduced.js"); let writes=0;
  stub(t,UserProfile,"findById",()=>query({status:"deactivated",devices:[]}));
  stub(t,Notification,"create",async()=>{writes++;return {_id:new mongoose.Types.ObjectId(),recipient_id:new mongoose.Types.ObjectId()};});
  await notifyUserLifecycleEvent({recipient_user_id:new mongoose.Types.ObjectId().toString(),entity_type:"sos",entity_id:new mongoose.Types.ObjectId().toString(),status:"safe"});
  assert.equal(writes,0);
});
test("Firestore synchronization failure is redacted and never throws to an accepted emergency",async t=>{
  const admin=(await import("../src/firebaseAdmin.js")).default;
  const {recordSosLocation}=await import("../src/services/sosLocationHistory.js");
  const writes=[];
  const doc={collection:()=>({doc:()=>({})})};
  const original=Object.getOwnPropertyDescriptor(admin,"firestore");
  Object.defineProperty(admin,"firestore",{configurable:true,value:()=>({collection:name=>({doc:id=>{assert.equal(name,"sos_sessions"); assert.equal(id,"case-id");return doc;}}),batch:()=>({set:(ref,value)=>writes.push(value),commit:async()=>{throw Object.assign(new Error("sensitive provider content"),{code:"unavailable"});}})})});
  t.after(()=>{if(original)Object.defineProperty(admin,"firestore",original);else delete admin.firestore;});
  const warnings=[]; t.mock.method(console,"warn",(...args)=>warnings.push(args));
  assert.equal(await recordSosLocation({sos_id:"case-id",user_id:"owner-id",latest_latitude:16,latest_longitude:120,location_updated_at:new Date(),latest_status:"active"}),false);
  assert.equal(writes.length,2); assert.equal(warnings[0][1].code,"unavailable"); assert.equal(JSON.stringify(warnings).includes("sensitive provider content"),false);
});
test("owner and accepted friend read Mongo latest coordinates; friendship grants no closure",async t=>{
  const owner=new mongoose.Types.ObjectId(),friend=new mongoose.Types.ObjectId(),sos=new mongoose.Types.ObjectId();
  const thread={_id:new mongoose.Types.ObjectId(),root_event_id:sos,user_id:owner,latest_status:"active",latitude:15,longitude:120,location_updated_at:new Date(),updated_at:new Date()};
  stub(t,SosRecord,"findOne",filter=>query(filter.record_type==="case"?thread:{latitude:16,longitude:121,created_at:new Date()}));
  stub(t,UserProfile,"findById",()=>query({full_name:"Owner"}));
  stub(t,FriendConnection,"exists",async()=>true);
  for(const viewer of [owner,friend]) {
    const res=response(); await route("/sos/:sosId/live","get")({params:{sosId:sos.toString()},userProfile:{_id:viewer}},res);
    assert.equal(res.body.latest_latitude,15); assert.equal(res.body.latest_longitude,120);
    assert.equal(res.body.can_close,viewer===owner); assert.ok(res.body.location_updated_at);
  }
  stub(t,UserProfile,"findOne",async()=>({_id:friend}));
  const res=response(); await route("/sos/:sosId/status","patch")({params:{sosId:sos.toString()},body:{status:"safe"},auth:{uid:"friend"}},res);
  assert.equal(res.statusCode,403);
});
test("outside-city tracking succeeds despite failed Firestore archive",async t=>{
  const admin=(await import("../src/firebaseAdmin.js")).default;
  const owner=new mongoose.Types.ObjectId(),sos=new mongoose.Types.ObjectId();
  const thread={_id:new mongoose.Types.ObjectId(),root_event_id:sos,user_id:owner,latest_status:"active",latitude:16,longitude:120,updated_at:new Date()};
  stub(t,SosRecord,"findOne",filter=>query(filter.record_type==="case"?thread:{latitude:16,longitude:120,created_at:new Date()}));
  stub(t,UserProfile,"findById",()=>query({full_name:"Owner"}));
  stub(t,SosRecord,"findOneAndUpdate",(filter,update)=>{assert.equal(filter.latest_status,"active");Object.assign(thread,update.$set);return query(thread);});
  Object.defineProperty(admin,"firestore",{configurable:true,value:()=>{throw Object.assign(new Error("archive unavailable"),{code:"unavailable"});}});
  t.after(()=>delete admin.firestore);
  const res=response(); await route("/sos/:sosId/location","patch")({params:{sosId:sos.toString()},body:{latitude:14.5995,longitude:120.9842},userProfile:{_id:owner}},res);
  assert.equal(res.statusCode,200); assert.equal(thread.latitude,14.5995);assert.equal(res.body.latest_latitude,14.5995);assert.ok(thread.location_updated_at);
  await new Promise(resolve=>setImmediate(resolve));
});
test("deactivated accounts cannot read or acknowledge broadcast deliveries",async t=>{
  const {default: router}=await import("../src/routes/broadcastRoutes.js");
  const {Notification}=await import("../src/models/Reduced.js"); let reads=0,writes=0;
  stub(t,UserProfile,"findOne",async()=>({_id:new mongoose.Types.ObjectId(),status:"deactivated"}));
  stub(t,Notification,"find",()=>{reads++;throw new Error("Unauthorized read");});
  stub(t,Notification,"findOneAndUpdate",()=>{writes++;throw new Error("Unauthorized write");});
  for(const [path,method] of [["/admin/broadcasts/my/inbox","get"],["/admin/broadcasts/:id/ack","post"]]) {
    const res=response(); await router.stack.find(layer=>layer.route?.path===path&&layer.route.methods[method]).route.stack.at(-1).handle({auth:{uid:"disabled"},params:{id:new mongoose.Types.ObjectId().toString()}},res);
    assert.equal(res.statusCode,403); assert.equal(res.body.code,"ACCOUNT_DEACTIVATED");
  }
  assert.equal(reads,0);assert.equal(writes,0);
});
test("SSE replay finishes in order before the snapshot despite delayed authorization",async t=>{
  const {subscribeSse,publishSosDeltaBySosId,replaySince,writeSnapshotToStream}=await import("../src/services/sosLiveOps.js");
  const sos=new mongoose.Types.ObjectId(),owner=new mongoose.Types.ObjectId();
  const thread={_id:new mongoose.Types.ObjectId(),root_event_id:sos,user_id:owner,latest_status:"active",updated_at:new Date()};
  stub(t,SosRecord,"findOne",filter=>query(filter.record_type==="case"?thread:{created_at:new Date()}));
  stub(t,UserProfile,"findById",()=>query({full_name:"Owner"}));
  const original=[];const collector={write:x=>original.push(x)};
  const stop=subscribeSse(collector,async()=>true);
  await publishSosDeltaBySosId(sos); await publishSosDeltaBySosId(sos);
  await new Promise(resolve=>setImmediate(resolve));stop();
  const firstId=Number(original.find(line=>line.startsWith("id:")).slice(3));
  const writes=[];let validation=0;
  const stream={write:x=>writes.push(x),end(){}};
  const unsubscribe=subscribeSse(stream,async()=>{if(++validation===1)await new Promise(resolve=>setTimeout(resolve,20));return true;});t.after(unsubscribe);
  const replay=replaySince(firstId-1,stream);
  const snapshot=writeSnapshotToStream(stream,[]);
  await Promise.all([replay,snapshot]);
  assert.deepEqual(writes.filter(line=>line.startsWith("event:")),["event: delta\n","event: delta\n","event: snapshot\n"]);
});

test("an asynchronous SSE write failure closes the subscriber without an unhandled rejection",async t=>{
  const {subscribeSse,publishSosDeltaBySosId,getSosStreamMetrics}=await import("../src/services/sosLiveOps.js");
  const sos=new mongoose.Types.ObjectId(),owner=new mongoose.Types.ObjectId();let closed=false;
  const thread={_id:new mongoose.Types.ObjectId(),root_event_id:sos,user_id:owner,latest_status:"active",updated_at:new Date()};
  stub(t,SosRecord,"findOne",filter=>query(filter.record_type==="case"?thread:{created_at:new Date()}));
  stub(t,UserProfile,"findById",()=>query({full_name:"Owner"}));
  const before=getSosStreamMetrics().sos_stream_clients_active;
  const stream={write(){throw new Error("Disconnected stream");},end(){closed=true;}};
  const unsubscribe=subscribeSse(stream,async()=>{await new Promise(resolve=>setImmediate(resolve));return true;});t.after(unsubscribe);
  await publishSosDeltaBySosId(sos);
  assert.equal(closed,true);
  assert.equal(getSosStreamMetrics().sos_stream_clients_active,before);
});
