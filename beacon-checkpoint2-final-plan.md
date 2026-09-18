# Beacon Checkpoint 2 - Final Plan

## Goal and scope

Complete the given minimum security checklist using the existing React admin dashboard, Express/Node backend, PostgreSQL, and MongoDB Atlas with Mongoose. Items are complete only after verification; this plan does not claim they are already implemented.

Keep the agreed polyglot approach and the existing React admin registration/login. Retain Firebase authentication for mobile users. Reuse existing permission middleware, manual validation patterns, and the custom rate limiter. Add only Mongoose and Helmet. No new authentication system, generic repository framework, role middleware, or background processing platform.

## 1. Database migration

| Remains in PostgreSQL | Moves to MongoDB |
|---|---|
| Users, admins including personnel, roles/permissions | Admin notifications |
| Devices and Firebase user mapping | User notifications |
| Contacts, friendships and friend requests | Broadcasts |
| SOS threads/events and incident reports/images | Broadcast recipient deliveries |
| Admin access requests | Report-run history |

Analytics continue reading PostgreSQL; only generated report metadata moves. Push tokens remain in PostgreSQL.

Implementation:
- Add one Mongoose connection module, five feature models, and a small counter model for atomic numeric IDs. Connect before accepting traffic.
- Preserve existing routes, request/response shapes, timestamps, and numeric public IDs. Store unique numeric public_id values and serialize them as existing API id fields. MongoDB _id stays internal. Validate public IDs as positive safe integers.
- Preserve notification is_read, recipient IDs and metadata; broadcast audience_roles and legacy audience_role_ids; report fields report_key, range_key, timezone, generated_by_admin_id, generated_at, and payload_hash.
- Keep numeric broadcast/user references in deliveries. Add unique public-ID indexes, recipient/time indexes for inboxes, a unique broadcast/user delivery index, and a report key/range/timezone/generated-time index.
- Validate schema types, required fields, enums, and suitable size limits, including updates. Construct database filters and updates explicitly; never pass arbitrary request objects into database operations.
- Use one rerunnable migration script to initialize indexes/counters and upsert historical records by stable IDs. Verify counts, key fields, references, and API output. Counters start at least at imported maximum IDs and never decrease on reruns.

### Complete CRUD through React

Use broadcasts as the Mongo-backed CRUD demonstration: create, list, edit a draft, and delete a draft. Add only missing update/delete endpoints and React controls. Restrict deletion to admins. Reject edits/deletes after sending, with draft status included in the database mutation to prevent races. Do not add incident deletion just for the checklist.

### Preserve write consistency

- Admin access requests currently insert a PostgreSQL notification in the same transaction. After migration, commit the request first, then attempt its Mongo notification and record failures. Requests remain discoverable in the existing request list. Document this loss of atomic notification delivery; do not report a committed request as failed because its notification failed.
- Both broadcast send/publish paths must read the PostgreSQL audience, then commit the Mongo send marker and recipient deliveries together in a MongoDB transaction. Use a conditional send-once update and unique delivery keys.
- After commit, use Mongo recipient IDs to load PostgreSQL device tokens and send pushes. Record push failures separately. Do not claim exactly-once push delivery.

## 2. Three roles and least privilege

Use actual roles: **admin**, **personnel** (responder), and **citizen**. Student remains an existing mobile role. Do not create a duplicate responder role.

| Capability | Admin | Personnel | Citizen |
|---|---|---|---|
| Admin dashboard | Yes | Assigned permissions | No |
| SOS/incident administration | Authorized operations | Assigned operational permissions | No |
| Mobile records/inbox | Requires mobile identity | Requires mobile identity | Existing ownership/access rules |
| Broadcast creation/edit/send and reports | Authorized operations | Only explicitly granted permissions | Targeted inbox/acknowledgment only |
| Delete draft broadcasts | Yes | No | No |
| Manage accounts or grant privileges | Existing management permissions | No privilege grants | No |

Reuse requireAdminAuth/requireAuth, requirePermission, and existing permission tables. Verify actual grants and correct excessive access. Signup must assign low-privilege personnel and reject or ignore attempted role/permission elevation.

Preserve authenticated recipients' existing accept/decline workflow for admin access requests. Preserve authorized friend-SOS visibility and targeted broadcasts while enforcing private inbox ownership.

React guards and controls reflect backend permissions; backend enforcement remains authoritative, including the SOS SSE handshake. Demonstrate allowed and denied operations for each role. Rejecting a Firebase token at an admin endpoint alone does not prove three-role RBAC.

## 3. Minimum security checklist

Existing behavior still requires verification. React behavior described in CODEBASE_SUMMARY.md must be checked in the actual admin application.

| Checklist item | Minimal work and acceptance evidence |
|---|---|
| **MERN: React frontend implemented** | Run the existing dashboard; demonstrate authentication and Mongo-backed broadcast CRUD. |
| Express/Node backend implemented | Start the existing backend and exercise its routes. |
| MongoDB database implemented | Connect to Atlas; verify historical data and new writes persist. |
| Mongoose models implemented | Use the five validated feature models for migrated persistence. |
| REST API implemented | Preserve existing APIs; add only missing draft update/delete endpoints. |
| CRUD operations working | Create, list, edit, delete a draft through React; verify persistence after refresh. |
| **Authentication: Registration implemented** | Existing signup creates personnel and cannot grant elevated privileges. |
| Login implemented | Valid credentials succeed; invalid credentials receive a generic failure. |
| Password hashing implemented | Keep bcrypt; verify plaintext passwords are never stored and hashes are never returned. |
| JWT/session authentication implemented | Verify existing admin JWT protection; retain Firebase for mobile. |
| Logout implemented | React clears token/auth state and redirects; protected navigation requires login. Existing stateless tokens remain valid until expiry; immediate server revocation is outside this checklist scope. |
| Token expiration implemented | Keep existing JWT expiration; prove expired tokens return 401. |
| **Authorization: At least 3 roles** | Demonstrate actual admin, personnel, citizen accounts with distinct allowed/denied operations. |
| RBAC implemented | Verify permission assignments and server enforcement against section 2. |
| Protected routes implemented | Test APIs, React protected navigation, and SOS SSE authentication. |
| Least privilege applied | Verify low-privilege signup, management/delete restrictions, ownership, and an Atlas user scoped to the application database. |
| **API Security: Input validation** | Validate required fields, types, lengths, enums, numeric IDs; use schema validation as a second layer. |
| Request validation | Validate body shape, parameters, filters/pagination and allowed update fields. Reject malformed JSON and objects/operators where scalars are expected. Review existing routes for equivalent gaps. |
| Safe error handling | Preserve response envelopes and use generic server errors. Remove database details from /health/db and other exposed error paths. |
| Helmet/security headers | Mount helmet() before routes and verify response headers. |
| Rate limiting | Retain the custom limiter; verify login/signup and existing write-route coverage, including 429 responses. |
| Audit logging | Add one structured helper writing to retained server logs: auth outcomes, denied privileged actions, account/permission changes, broadcast mutations/sends, report generation. Include time, actor when known, action, target and outcome. |
| No sensitive information in responses | Inspect success/errors for hashes, credentials, stack traces and database details. Login's intended token is permitted; logs exclude passwords, tokens, connection strings and raw bodies. |

Keep secrets in environment variables: MONGODB_URI, existing ADMIN_JWT_SECRET, and existing PostgreSQL/Firebase settings. Update .env.example with placeholders; verify .env is ignored. Restrict Atlas network access to backend needs and use encrypted connections. No separate audit database/UI or generic validation framework.

## 4. Implementation order

1. Record existing API shapes, permission grants, tests and React authentication behavior. Confirm access to React source for CRUD edits.
2. Add Mongo connection, models, indexes, counters, import and verification against a development database.
3. Cut over notifications, broadcasts/deliveries, then report history. Update all readers/writers, both broadcast send paths and push recipient lookup. Complete React draft CRUD.
4. Add Helmet, audit logging, missing validation, generic errors and required permission corrections.
5. Run existing tests plus focused checks below. Record real results before marking checklist rows complete.

## 5. Verification

| Scenario | Expected result |
|---|---|
| Signup, login, logout, expired JWT | Low-privilege account, hashed password, correct session behavior; expired JWT rejected with 401 |
| Missing/invalid admin token, including SSE | 401 before protected data/stream |
| Authenticated personnel attempts admin-only action | 403; no mutation |
| Citizen permitted operations and another user's private inbox | Permitted actions succeed; other recipient's data is not exposed or changed |
| React Mongo-backed broadcast CRUD | All four operations persist; sent records cannot be edited/deleted |
| Invalid body/query/ID/enum/operator payload | Controlled validation failure, normally 400; no leaked internals |
| Concurrent broadcast send/publish | One committed send, one delivery per recipient, no partial marker/delivery commit |
| Broadcast push lookup | Mongo recipients correctly map to PostgreSQL device tokens |
| Notification failure after committed admin request | Request remains listed; notification failure recorded |
| Inbox list/read and report generation/export | Recipient isolation, compatible responses, unchanged analytics |
| Rate limit and headers | 429 at configured threshold; Helmet headers present |
| Audit events and response inspection | Required events recorded; no unintended secrets exposed |
| Migration rerun and regression tests | No duplicates/lowered counters; fields match; SOS/incidents/friends still work |

Record request/command, expected result, actual result and pass/fail. Test owned development/test environments. Keep tests focused on these behaviors; no new test framework is needed.

## 6. Cutover and rollback

Back up PostgreSQL and pause writes to migrating features during final import, verification and cutover. Resume after checks pass. Keep original tables intact during acceptance; no dual writes or migration-flag framework.

Before MongoDB accepts new writes, rollback can restore the original application against PostgreSQL. After new Mongo writes, a code revert alone is insufficient: pause affected writes, reconcile Mongo changes back into PostgreSQL (including updates/deletions and sequences), verify, then restore the old application. Do not claim automatic lossless rollback without reconciliation.

## 7. Completion boundary

Complete means every section 3 row has passing evidence, including React CRUD and three-role authorization. Retain the RBAC matrix, test results, sanitized Atlas evidence and .env.example.

Polyglot follows the agreed project direction; this plan does not assert instructor approval. Deployment remains a later task. The broader Checkpoint 2 template also requires HTTPS deployment, repository/frontend/backend links, architecture and MERN/polyglot flow diagrams, and deployed screenshots/demo evidence. Those remain pending until delivered; passing the local minimum checklist alone does not complete the full submission.
