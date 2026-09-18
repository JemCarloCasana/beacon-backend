# Beacon Checkpoint 2 - Phase-by-Phase Implementation

Source: [Final plan](beacon-checkpoint2-final-plan.md). This document breaks its scope into executable phases; all phases are initially pending. Complete each phase's checks before marking it done. Feature changes below run in development first; live cutover is a separate final step.

## Phase overview

| Phase | Outcome | Status |
|---|---|---|
| 1 | Baseline and access confirmed | Pending |
| 2 | Atlas connection and Mongoose models ready | Pending |
| 3 | Historical import verified | Pending |
| 4 | Notifications use MongoDB | Pending |
| 5 | Broadcast persistence and API CRUD use MongoDB | Pending |
| 6 | Report-run history uses MongoDB | Pending |
| 7 | React broadcast CRUD and authentication verified | Pending |
| 8 | Authorization and API security checklist closed | Pending |
| 9 | Integrated verification and evidence complete | Pending |
| 10 | Final data cutover rehearsed or performed in the authorized environment | Pending |

## Phase 1 - Establish the baseline

**Work**

- Run the existing backend tests using the package's current test command; record pre-existing failures separately.
- Record migrated endpoints' request/response shapes, numeric IDs, date serialization, recipient rules, and broadcast send/publish behavior.
- Trace every reader/writer of the five migrating domains, including notification producers, admin-request creation, push delivery, and latest report-run lookup.
- Inspect actual admin/personnel permission grants and citizen access rules.
- Locate the React admin source. Confirm signup/login, logout, route guards, and broadcast screens against the source; CODEBASE_SUMMARY.md alone is not implementation proof.
- Confirm development PostgreSQL, Atlas access, and test identities for admin, personnel, and citizen. Keep credentials out of notes and test output.

**Likely files:** package.json, server.js, src/middleware/adminAuth.js, affected routes/services, existing tests; React source in its own project.

**Done when:** baseline results, API contracts, and affected call sites are recorded. If React source or Atlas access is unavailable, mark that dependency pending and continue independent backend work.

## Phase 2 - Add Atlas and Mongoose foundations

**Depends on:** Phase 1.

**Work**

- Add mongoose and one src/mongo.js connection module. Connect before the server accepts requests and close the connection during existing shutdown handling.
- Configure MONGODB_URI through the environment. Add placeholders to .env.example; preserve ADMIN_JWT_SECRET and existing PostgreSQL/Firebase settings.
- Configure a database-scoped Atlas user, appropriate network access, and encrypted connectivity. Verify the development environment supports the transaction required for broadcast sending.
- Add five feature models: admin notifications, user notifications, broadcasts, broadcast deliveries, and report runs. Add one small counter model for numeric ID allocation.
- Preserve the final plan's field names and numeric references. Serialize public_id as API id; keep _id internal.
- Add required types, enums, limits, update validation, and indexes from the final plan. Keep these models direct; no repository abstraction.
- Return generic health failures without connection details, including the existing /health/db path.

**Done when:** startup connects successfully, invalid documents are rejected, required indexes exist, concurrent counter allocation produces distinct IDs, and connection failures reveal no credentials.

**Checklist covered:** MongoDB, Mongoose, safe errors, database least privilege.

## Phase 3 - Import and verify historical data

**Depends on:** Phase 2.

**Work**

- Add one rerunnable script for initialization/import/verification, reusing the models.
- Import PostgreSQL notifications, user_notifications, broadcasts, broadcast_user_deliveries, and admin_report_runs into the development MongoDB database using stable keys.
- Preserve IDs, timestamps, read/acknowledgment state, audience fields, metadata, and report hashes. Verify delivery references and recipients.
- Advance each counter to at least the imported maximum without decreasing an existing counter.
- Compare counts and key fields, then rerun and verify no duplicates or counter regression.
- Keep import as an explicit maintenance command. Never run a PostgreSQL reimport automatically after MongoDB becomes authoritative; it could overwrite newer MongoDB changes.

**Done when:** import comparisons pass and rerunning against the unchanged source is safe. PostgreSQL data remains intact.

## Phase 4 - Move notification reads and writes

**Depends on:** Phase 3.

**Work**

- Update mobile/admin inbox listing and mark-read operations to Mongoose, preserving response shapes and numeric IDs.
- Update all notification producers identified in Phase 1, including lifecycle notifications and admin access requests.
- Filter reads/updates by the authenticated recipient, not just the notification ID.
- For admin access requests, commit PostgreSQL first, then attempt Mongo notification creation. Record failures without reporting the committed request as failed. Verify the request remains visible through the existing request list.
- Keep user mapping, device tokens, and existing push behavior in PostgreSQL where applicable.

**Likely files:** src/routes/notificationRoutes.js, src/routes/adminAdminsRoutes.js, src/services/userNotifications.js, and other discovered notification producers.

**Done when:** admin/mobile inbox and mark-read checks pass, another recipient's records cannot be read or changed, and notification failure does not undo or misreport a committed admin request.

## Phase 5 - Move broadcasts and complete API CRUD

**Depends on:** Phase 3; perform after Phase 4 in the default sequence.

**Work**

- Move creation, listing, inbox, acknowledgment, send, and publish persistence to MongoDB.
- Preserve audience_roles and legacy audience_role_ids compatibility. Resolve audiences from PostgreSQL users.
- Make both send/publish paths use the same sending logic: a conditional send marker and recipient deliveries committed together in one MongoDB transaction, with unique delivery keys.
- Send pushes after commit. Read recipient IDs from MongoDB and device tokens from PostgreSQL; record push failures separately.
- Add draft update/delete endpoints only if missing. Validate allowed fields and numeric IDs, require existing broadcast permissions for editing, and restrict deletion to admins through existing authorization patterns.
- Include unsent status in edit/delete database filters so concurrent sending cannot bypass draft restrictions.

**Likely files:** src/routes/broadcastRoutes.js, src/routes/adminBroadcastRoutes.js, src/services/fcm.js, broadcast models and existing broadcast tests.

**Done when:** API create/read/update/delete works, sent records reject edits/deletes, unauthorized deletion is denied, and concurrent send/publish commits one send with one delivery per recipient. A transaction failure leaves no partial send marker/delivery set. Push failure does not roll back persisted state.

**Checklist covered:** REST, Mongo-backed CRUD, validation, authorization.

## Phase 6 - Move report-run history

**Depends on:** Phase 3; perform after Phase 5 in the default sequence.

**Work**

- Replace admin_report_runs inserts and latest-run lookups with Mongoose.
- Preserve report_key, range_key, timezone, generated_by_admin_id, generated_at, and payload_hash.
- Keep SOS/incident analytics and CSV data queries in PostgreSQL.

**Likely files:** src/routes/adminReportsRoutes.js, report-run model, src/adminReportsRoutes.test.js.

**Done when:** generated metadata persists in MongoDB and overview/export results match the baseline for the same PostgreSQL data.

## Phase 7 - Complete the React demonstration

**Depends on:** Phase 5 and access to the React source.

**Work**

- Reuse the broadcast screen and API client for create/list; add only missing draft edit/delete controls.
- Match backend permissions: personnel cannot delete; sent broadcasts cannot be edited/deleted. Show API failures clearly and refresh displayed data after mutations.
- Verify existing registration and login against the backend, password hashing in storage, and generic invalid-login errors.
- Verify logout clears the token/auth state and redirects. Test expired-token behavior and protected navigation.
- Keep the existing authentication architecture. Document that local logout does not revoke a previously issued stateless JWT before its expiration.

**Done when:** the actual React app demonstrates all four Mongo-backed CRUD operations with persistence after refresh, plus working registration/login/logout and protected navigation. Keep this phase pending if only the frontend summary is available.

**Checklist covered:** React, CRUD, registration, login, hashing, JWT/session auth, logout, expiration.

## Phase 8 - Close authorization and API security gaps

**Depends on:** Phases 4-6; coordinate React guard changes with Phase 7. Validation and access control must already accompany each new endpoint; this phase checks the complete application.

**Work**

- Reuse requireAdminAuth/requireAuth, requirePermission, and existing permission tables. Verify admin, personnel, and citizen grants against the final plan; fix excessive permissions without adding a duplicate responder role.
- Verify signup cannot assign elevated roles/permissions. Preserve recipients' authorized admin-request accept/decline workflow and existing friend-SOS visibility.
- Verify backend route protection, inbox ownership, and the SOS SSE handshake. Reflect restrictions in React controls.
- Add helmet before routes. Retain and test the existing custom limiter, including login/signup and current write-route coverage.
- Review body shape, fields, enums, lengths, numeric IDs, query filters/pagination, malformed JSON, and object/operator injection at request boundaries. Use explicit query/update fields and Mongoose update validation.
- Keep response envelopes compatible while removing stack traces and database/credential details from errors and unintended sensitive fields from successful responses.
- Add one structured audit helper writing to retained server logs. Record auth outcomes, denied privileged actions, account/permission changes, broadcast mutations/sends, and report generation with time, actor when known, action, target, and outcome. Never log passwords, tokens, connection strings, or raw bodies.

**Done when:** unauthenticated/expired-token requests return 401, authenticated forbidden actions return 403, excessive attempts return 429, malformed requests fail safely, headers are present, and required sanitized audit events are retained. All three roles have both allowed and denied test cases.

**Checklist covered:** all authorization and API security items.

## Phase 9 - Run integrated acceptance and collect evidence

**Depends on:** Phases 1-8.

**Work**

- Run the existing test suite and focused migration/security checks using the existing test tools. Record pre-existing failures separately; unresolved failures affecting this scope block completion.
- Execute every scenario in section 5 of the final plan, including concurrency, transaction failure, notification failure, isolation, API compatibility, and unchanged SOS/incidents/friend behavior.
- Capture React authentication/CRUD evidence, sanitized Atlas persistence evidence, the actual RBAC matrix, and security results.
- Map all 23 checklist items in section 3 of the final plan to evidence. Record expected result, actual result, pass/fail, and command/request; leave unverified items pending.

**Done when:** every minimum-checklist row has passing evidence. Merely having code or a frontend summary is insufficient.

## Phase 10 - Final cutover and rollback readiness

**Depends on:** Phase 9. Rehearse in development first. Production deployment remains a separate task.

**Work**

- Back up PostgreSQL and pause writes to the migrating features for the final import, verification, and application switch. Resume after checks pass.
- Keep original PostgreSQL tables intact during acceptance. Do not introduce dual writes or a migration-flag framework.
- Before new Mongo writes, rollback can restore the old application against PostgreSQL.
- After new Mongo writes, pause affected writes and reconcile Mongo changes back to PostgreSQL, including edits, deletions and sequences, before restoring the old application. Verify reconciliation; a code revert alone is insufficient.
- Record whether this phase was rehearsed or actually executed, the environment, verification results, and the active source of truth.

**Done when:** the target environment's migration is verified or the development rehearsal is clearly documented. Do not label production migration complete based on a rehearsal.

## Stop condition and deferred submission work

Stop adding features when the final plan's minimum checklist passes. Keep PostgreSQL for the agreed domains, Firebase mobile authentication, the current rate limiter, and existing permission middleware. No new auth system, generic framework, audit UI/database, background queue, or incident-deletion feature is required.

HTTPS deployment, live frontend/backend URLs, repository submission, architecture/data-flow diagrams, and deployed screenshots/demo evidence remain separate broader Checkpoint 2 deliverables. Local checklist completion does not imply those submission requirements are complete.
