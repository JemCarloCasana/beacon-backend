# Lean Full PostgreSQL-to-MongoDB Plan

This plan moves the remaining Beacon application data from PostgreSQL to MongoDB Atlas without adding unnecessary migration infrastructure. Firebase Authentication and FCM remain external services.

## Phase 10 — Add remaining MongoDB models

Create Mongoose models and indexes for the PostgreSQL domains still used at runtime:

- Users and profiles
- Admins, roles, and permissions
- Contacts
- Friendships and friend requests
- Devices and push tokens
- SOS threads and events
- Incident reports and evidence
- Admin access requests

Preserve existing numeric IDs, timestamps, status values, ownership rules, and API response shapes.

Use:

- Unique indexes for email, Firebase UID, Beacon Code, and relationship pairs.
- Explicit schema validation for enums, required fields, lengths, and IDs.
- References between users, admins, SOS records, incidents, and notifications.
- MongoDB transactions only for operations that must update multiple documents together.

Firebase Authentication and FCM remain external services.

## Phase 11 — Migrate routes and services

Move PostgreSQL reads and writes to MongoDB in this order:

1. Users, profiles, contacts, friendships, and devices.
2. Admins, roles, permissions, and admin access requests.
3. SOS threads, events, assignments, and live operations.
4. Incident reports, evidence metadata, and status history.
5. Remaining notification recipient and token lookups.
6. Analytics and report queries after MongoDB equivalents produce matching results.

Keep the existing REST endpoints and response envelopes. Remove PostgreSQL access from each route only after its replacement passes tests.

Maintain:

- Admin JWT behavior.
- Firebase mobile authentication.
- Three-role RBAC.
- Recipient ownership checks.
- SOS SSE authentication and authorization.
- Existing push delivery behavior.

## Phase 12 — Historical migration and verification

Create one rerunnable migration command for all remaining PostgreSQL domains.

It must:

- Upsert by stable public ID.
- Preserve timestamps and status history.
- Validate references and report orphaned records.
- Initialize counters above imported maximum IDs.
- Avoid duplicates on rerun.
- Never lower existing counters.
- Compare source and target record counts.
- Compare representative records for each domain.

Use a disposable Atlas test database. Do not run the migration against production data without an explicit backup and environment check.

## Phase 13 — Integrated acceptance

Run the existing backend and React tests, then add focused MongoDB integration tests for:

- User/profile ownership.
- Friend request and friendship uniqueness.
- Device registration and token cleanup.
- Admin login, deactivation, roles, and permissions.
- SOS creation, acknowledgement, resolution, and SSE.
- Incident lifecycle and assignments.
- Notification isolation and mark-read behavior.
- Broadcast send/publish concurrency.
- Report generation and aggregation results.
- Transaction rollback and unique indexes.
- Invalid input, rate limits, Helmet headers, audit logging, and safe responses.

Verify the React admin application against MongoDB for:

- Login/logout.
- Personnel registration.
- Permission-based controls.
- Broadcast CRUD.
- Reports and SOS screens.

## Phase 14 — Cutover rehearsal and final switch

### Rehearsal

1. Back up PostgreSQL.
2. Freeze writes to migrating domains.
3. Run the full migration.
4. Start the MongoDB-backed application.
5. Run the integrated acceptance matrix.
6. Confirm counts, critical records, permissions, notifications, and API responses.
7. Record rollback steps.

### Final cutover

1. Back up PostgreSQL again.
2. Pause affected writes.
3. Run the final migration.
4. Start MongoDB-backed routes.
5. Run smoke checks.
6. Monitor errors and latency.
7. Keep PostgreSQL backups available for recovery.

After MongoDB receives new writes, rollback requires reconciling those changes back into PostgreSQL before restoring the old application.

## Completion criteria

The migration is complete when:

- No migrated runtime route reads or writes PostgreSQL.
- MongoDB contains all required records and indexes.
- Existing API contracts remain compatible.
- Admin, personnel, and citizen authorization tests pass.
- SOS, incidents, friendships, contacts, devices, notifications, broadcasts, and reports work against MongoDB.
- React tests and build pass.
- Atlas transaction and rollback checks pass.
- Migration reruns without duplicates or counter regression.
- Cutover and rollback evidence is recorded.

This plan uses four focused phases instead of eleven administrative phases and leaves Firebase Authentication, FCM, and other external services unchanged.
