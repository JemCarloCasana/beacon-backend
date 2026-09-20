# Beacon Phase 1-5 - Bug Fix Implementation Plan

Based on the Phase 1-5 review and [implementation phases](beacon-checkpoint2-implementation-phases.md). The eight fixes below are implemented. Verification results are recorded at the end; this does not mark the entire migration or later phases complete.

## Scope and rules

Fix the seven reported findings plus the multicast limit in eight small steps. Preserve numeric public IDs, separate send/publish response envelopes, draft-only mutations, and existing admin-request 201 behavior. Reuse current models, permissions, and tests; add no dependencies or new infrastructure.

Use stubs for route/error paths and real Mongoose for behavior stubs cannot prove. Reserve persistence, indexes, concurrency, and transactions for an isolated Atlas test database. Never run the import against an active authoritative MongoDB database during verification.

## 1. Repair broadcast acknowledgment

**Files:** src/routes/broadcastRoutes.js; src/broadcastRoutes.auth.test.js.

- Enable the required updatePipeline option on the existing acknowledgment pipeline.
- Retain recipient-scoped filtering and the existing timestamp-preserving $ifNull expression.
- Keep the response contract unchanged.

**Checks:** Construct the query using actual installed Mongoose without replacing findOneAndUpdate; it must not throw. In the isolated database, the first acknowledgment sets a timestamp, a second preserves it, and another recipient cannot acknowledge the delivery.

**Done:** Valid acknowledgments no longer return 500; timestamp and ownership behavior pass.

## 2. Enforce admin-only draft deletion

**Files:** src/routes/broadcastRoutes.js; existing broadcast authorization tests. Touch src/middleware/adminAuth.js only if reusing its account lookup avoids a duplicate query.

- Keep the existing manage_broadcasts permission requirement.
- Before deletion, verify the account's current role from PostgreSQL. Do not rely solely on a role embedded in an older JWT.
- Return 403 for personnel even when they have manage_broadcasts; do not revoke that permission from personnel who need other broadcast operations.
- Preserve the atomic unsent filter, 404 for missing records, 409 for sent records, and 200 { ok: true, broadcast_id } on success.
- Use a narrow check in the existing path; do not build a generic role framework.

**Checks:** Exercise the full route middleware chain with an admin, personnel with manage_broadcasts, an account without the permission, and no token. A denied request must never invoke deletion. Include a stale admin-role token whose current database role is personnel.

**Done:** Only a currently authorized admin can delete a draft.

## 3. Validate the complete broadcast audience

**Files:** src/routes/broadcastRoutes.js; src/models/Broadcast.js; src/services/broadcastSend.js; existing broadcast tests.

- Build the resulting draft state from existing fields plus the proposed patch and validate it before saving.
- A role audience must have a valid non-empty audience_roles selector or the supported audience_role_ids fallback. Preserve the existing selector precedence.
- Keep the same invariant on document creation/import. Query update validators alone do not reliably validate relationships between unchanged and changed fields.
- Keep unsent status in the atomic update filter. Use the original audience fields as additional match conditions when deriving an update from them so a concurrent audience edit cannot invalidate the result; return a conflict if they changed.
- Reject invalid stored audience configurations before committing a send. Distinguish an invalid selector from a valid audience that currently matches zero users.
- Return controlled 400 responses for caller validation failures, including model length limits, rather than turning them into generic 500 errors.

**Checks:** all-to-role without selectors fails; valid modern/legacy selectors succeed; role-to-all clears selectors; unrelated edits preserve a valid audience; invalid stored audiences cannot be sent; concurrent audience edits do not create an invalid combination. Oversized title/body returns 400.

**Done:** No accepted create/edit produces an unusable role audience.

## 4. Separate committed sends from push failures

**Files:** src/services/fcm.js; src/routes/broadcastRoutes.js; src/routes/adminBroadcastRoutes.js; existing broadcast tests.

- Keep the MongoDB transaction responsible for the send marker and recipient deliveries.
- Handle post-commit recipient lookup, Firebase, and invalid-token cleanup failures separately from persistence failure. Prefer one shared push helper over duplicating behavior in send and publish.
- Preserve both routes' current successful outer envelopes. On push failure, return the committed send as successful and put an additive, generic error indicator inside the existing push result. Preserve existing push count fields; do not invent recipient counts when lookup failed.
- Log the broadcast ID and sanitized failure stage. Never return raw SDK/database errors or device tokens.
- Update the existing test that currently expects 500 after push lookup fails. Retrying an already committed send still returns 409.

**Checks:** Failed transaction returns an error and never attempts pushes. Post-commit push failures preserve deliveries and return a successful send/publish response with a truthful push failure result. Cleanup failure must not erase known successful push counts.

**Done:** Clients no longer see a failed broadcast operation when persistence succeeded.

## 5. Batch multicast notifications

**Files:** src/services/fcm.js; a focused test using the existing Node test tools.

- Split distinct device tokens into sequential batches of at most 500.
- Accumulate success/failure counts and map each response to the tokens in its own batch.
- Handle failed batches independently so later batches are attempted; expose partial/error status without claiming confirmed delivery for a rejected batch.
- Preserve invalid-token cleanup and prevent cleanup failures from misreporting completed sends.
- Do not add automatic retry queues, workers, or a claim of exactly-once delivery.

**Checks:** 0, 1, 500, and 501 tokens; a failed batch followed by a successful one; invalid-token cleanup uses the correct batch tokens. Stub Firebase so tests send no real notifications.

**Done:** Larger audiences stay within SDK limits and aggregate results accurately.

## 6. Validate imported documents before bulk writes

**Files:** scripts/migrate-mongo.js; relevant models; one focused migration test file if none exists.

- Validate mapped documents with their actual Mongoose model before building bulk updateOne operations. bulkWrite update operations alone are not schema-validation proof.
- Report the domain and stable record key with sanitized failing field names; fail the import rather than silently accepting invalid documents. Do not silently truncate historical data to fit limits.
- Await model/index initialization before importing dependent data.
- Retain stable upsert keys and counter floors. Use atomic $max for counter advancement rather than read-then-$set so advancement cannot lower a concurrently incremented counter.
- Keep import rerunnable after a partial failure; do not add a cross-database transaction system.

**Checks:** Invalid enums, unsafe public IDs, oversized fields, and invalid audience configurations are rejected before the affected batch is written. Valid mapped records preserve fields. Repeated import creates no duplicates; counter advancement never decreases its value.

**Done:** Historical data receives the same applicable model validation as new records.

## 7. Strengthen migration preservation checks

**Files:** scripts/migrate-mongo.js; focused migration tests.

- Compare imported records by stable keys and all fields the mapping promises to preserve, rather than checking only a few early rows.
- Compare actual broadcast/recipient pairs, delivery and acknowledgment timestamps, and the referenced MongoDB broadcast's public ID. Equal counts do not establish matching recipients.
- Include notification metadata/message/read state, broadcast audience/content/state/timestamps, and report-run metadata/hash.
- Normalize dates and documented null/default mappings consistently for comparisons. Ignore internal _id values except when checking delivery references.
- Treat missing parents, skipped deliveries, missing/unexpected records in the isolated target, and field differences as verification failures with a nonzero exit code.
- Print counts and differing keys/field names, not private message contents or credentials.

**Checks:** Deliberately substitute one recipient while keeping counts equal, change an acknowledgment time, change metadata, and break a reference in isolated fixtures. Each mismatch must fail verification. Unchanged data and a rerun must pass.

**Done:** Verification proves the promised field/reference preservation, not just equal document counts.

## 8. Require MongoDB before accepting traffic

**Files:** server.js; src/mongo.js only if necessary; focused startup check.

- Remove optional startup without MONGODB_URI now that migrated routes depend on MongoDB.
- Call the existing connection function before app.listen and exit unsuccessfully on missing configuration or failed connection.
- Keep error messages generic. Retain both database health paths without exposing connection details.
- Test startup with isolated dependencies so the check does not execute migrations against a real application database. Avoid restructuring unrelated server code.

**Checks:** Missing URI and connection failure both prevent listening and produce a failing process result. Successful connection allows startup. Logs/responses contain no credentials.

**Done:** The API cannot appear started while its required MongoDB connection is unavailable.

## Final verification and acceptance

1. Run each focused regression check after its fix, then run npm.cmd test once all changes are complete. Add new regression files to the existing test command if needed so they are not forgotten.
2. Against an isolated Atlas database, verify acknowledgment idempotency, indexes, import reruns and parity, counter allocation, concurrent send/publish, and delivery-write rollback. Use synthetic records and stub external pushes.
3. If real Mongo transaction contention exposes a transient conflict, use the driver's supported transaction retry mechanism at the existing shared send helper; keep all push effects outside the retryable transaction. Do not invent a custom retry framework or treat stub concurrency as proof.
4. Record each finding as fixed/failed/unverified with its test evidence. Keep live-database checks pending when the isolated environment is unavailable.

Stop when these findings and the relevant Phase 1-5 acceptance checks pass. This work does not complete React integration, report-route migration, the broader security phase, or deployment. No production import or migration cutover is part of this fix pass.

## Implementation results - September 20, 2026

- Implemented all eight fixes. Live concurrency testing additionally exposed a transient write conflict; the shared send helper now uses the driver's withTransaction retry mechanism, with pushes still outside the transaction.
- PASS: npm.cmd test - 198 tests, zero failures, including eight new focused regression tests in src/phase1-5.regression.test.js.
- PASS: src/phase1-5.mongo.integration.test.js against a uniquely named Atlas test database - four live scenarios: import rerun/field preservation/unique indexes/counter allocation; concurrent send deduplication; acknowledgment idempotency and recipient isolation; rollback after delivery insertion failure.
- The isolated database was removed after testing. PostgreSQL recipient lookups and external push delivery were stubbed; no application records were imported or changed and no real push notifications were sent.
- Push failures preserve successful send/publish envelopes and existing count fields, adding a generic error field inside push and unknownCount only when a rejected batch has an uncertain delivery outcome.
- Historical application-data parity, React behavior, production cutover, and deployment remain outside these results.

Repeat local checks with npm.cmd test. Live checks are explicitly opt-in in PowerShell:

```powershell
$env:BEACON_RUN_MONGO_TESTS = '1'
node src/phase1-5.mongo.integration.test.js
```

The live test uses MONGODB_URI credentials but overrides the database name with a fresh beacon_fix_ prefix, verifies ownership, and removes only that generated database. It requires network access and privileges to create/remove a test database.
