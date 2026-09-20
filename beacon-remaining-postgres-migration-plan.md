# Remaining PostgreSQL-to-MongoDB Migration Plan

## Current state

The identity and relationship layer is MongoDB-backed when MongoDB is connected. Firebase Authentication remains external. PostgreSQL is still used by incident routes, administrative SOS operations, reporting, admin account-management workflows, and fallback branches.

Do not remove PostgreSQL or its fallback paths until each slice passes its contract and Atlas tests.

## Phase 1 — Inventory and migration gate

1. List every remaining `pool.query`, `pool.connect`, and PostgreSQL helper outside tests.
2. Map each query to its Mongo model and current response shape.
3. Confirm Atlas models and indexes for `SosThread`, `SosEvent`, `IncidentReport`, `IncidentEvidence`, `AdminAccount`, and `AdminAccessRequest`.
4. Add a runtime check that reports which database each route uses; do not log credentials.
5. Capture PostgreSQL response fixtures for comparison.

Completion: every remaining query has an owner, target model, and rollback path.

## Phase 2 — SOS operations

Migrate:

- User SOS creation and terminal status updates.
- Admin SOS list, detail, acknowledgement, assignment, notes, and resolution.
- SOS history and timeline queries.
- Live map/list and SSE snapshots/deltas.
- Admin SOS notification recipient lookup.

Use `SosThread` for current state and `SosEvent` for history. Preserve numeric IDs, status values, event ordering, ownership checks, `401`/`403`/`404`/`409` responses, and existing push envelopes.

Use a MongoDB transaction when a status change writes both the thread and event. Verify SSE authorization before opening the stream.

Tests: create, acknowledge, resolve, cancel, ownership denial, concurrent updates, event ordering, SSE authorization, and notification recipient isolation.

## Phase 3 — Incident reporting

Migrate:

- Mobile incident creation and detail/list reads.
- Evidence metadata and ownership checks.
- Admin incident list/detail, status transitions, priority, assignment, and resolution notes.

Use `IncidentReport` and `IncidentEvidence`. Keep image files in their existing external storage and store only URLs or references.

Tests: create, list, detail, evidence limits, invalid enums/IDs, ownership, status transitions, concurrent updates, and response parity with PostgreSQL fixtures.

## Phase 4 — Admin account management

Move the remaining admin routes to `AdminAccount`, `Role`, `Permission`, and `AdminAccessRequest`:

- Admin/personnel listing and profile updates.
- Activation and deactivation.
- Managed personnel creation if still using PostgreSQL.
- Access-request creation, approval, rejection, and cancellation.
- Admin notification recipient resolution for access requests.

Keep bcrypt hashes private, preserve JWT claims and permission grants, and retain the existing `requireAdminAuth` and `requirePermission` interfaces.

Tests: duplicate email, deactivated login, permission denial, access-request ownership, duplicate pending requests, approval/rejection races, and notification failure behavior.

## Phase 5 — Reports and analytics

Move report overview, report generation, latest-run lookup, and CSV export to Mongo-backed source collections:

- Aggregate incidents from `IncidentReport`.
- Aggregate SOS state/history from `SosThread` and `SosEvent`.
- Resolve user/admin fields from Mongo profiles and admin accounts.
- Store report-run history with native `Date` values.

Preserve date ranges, CSV columns, metric names, and response envelopes. Compare results with fixed PostgreSQL fixtures before removing SQL queries.

Tests: all supported ranges, empty ranges, latest-run scoping, native date sorting, CSV parity, authorization, and malformed filters.

## Phase 6 — Dependent services and fallback removal

After route tests pass, remove PostgreSQL lookups from:

- SOS and incident notification recipient resolution.
- Device-token lookup and cleanup.
- Admin notification recipient resolution.
- Broadcast audience resolution.
- Startup diagnostics that require PostgreSQL for normal operation.

Keep PostgreSQL only for rollback tooling until cutover is approved. Do not silently dual-write.

## Phase 7 — Import and parity verification

1. Import historical SOS, incident, admin, and report-run records into the disposable Atlas database.
2. Verify counts, numeric IDs, references, statuses, timestamps, event ordering, and indexes.
3. Run the importer twice and confirm idempotency and non-decreasing counters.
4. Compare representative API responses against PostgreSQL fixtures.
5. Confirm PostgreSQL row counts and checksums are unchanged.

## Phase 8 — Integrated acceptance and cutover preparation

Run the backend suite, Atlas integration tests, mobile smoke tests, admin browser tests, and the security checklist for all three roles.

Required mobile checks:

- Signup/profile bootstrap writes a Mongo profile.
- Contacts, friends, devices, notifications, broadcasts, SOS, and incidents read/write Mongo data.
- Ownership and deactivated-user rules remain enforced.
- Push notifications resolve Mongo recipients.

Only after all checks pass should the PostgreSQL fallback be disabled in staging. Production cutover and rollback rehearsal remain separate activities.

## Explicit boundaries

- No new repository layer, queue, authorization framework, or frontend redesign.
- No MongoDB `_id` in API responses.
- No public signup replacement for Firebase Authentication.
- No production cutover based only on source inspection or mocked tests.

