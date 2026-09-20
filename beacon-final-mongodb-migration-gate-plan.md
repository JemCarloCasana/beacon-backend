# Final MongoDB Migration Gate Plan

## Goal

Prove that the migrated runtime domains work against MongoDB Atlas, then remove PostgreSQL fallback paths in a controlled staging change. PostgreSQL remains available for rollback until every gate passes.

## Gate 1 — Disposable Atlas preflight

Run against the dedicated test database only:

```powershell
npm.cmd run mongo:preflight
```

Verify:

- SRV DNS resolves.
- Atlas connectivity succeeds.
- The database name is disposable.
- Read/write and index permissions work.
- No credentials appear in output.

## Gate 2 — Historical parity

Run:

```powershell
npm.cmd run mongo:import
npm.cmd run mongo:import
```

Record for both runs:

- PostgreSQL source counts.
- MongoDB collection counts.
- Numeric public-ID parity.
- Relationship references.
- Status and timestamp parity.
- Role and permission grants.
- Required indexes.
- Counter values before and after rerun.
- Duplicate and orphan counts.

The second run must be idempotent and must not lower counters.

## Gate 3 — Model and transaction checks

Run:

```powershell
node src/remainingModels.test.js
node src/phase1-5.mongo.integration.test.js
```

Add or run disposable Atlas checks for:

- Unique user/admin email.
- Beacon Code uniqueness.
- Device-token uniqueness.
- Friendship and pending-request uniqueness.
- Counter allocation under concurrent requests.
- SOS thread/event consistency.
- Incident/evidence references.
- Access-request decision consistency.
- Broadcast delivery transaction rollback.

## Gate 4 — API and role acceptance

Run the backend suite:

```powershell
npm.cmd test
```

Exercise each role against Atlas:

- Citizen: profile, contacts, friends, devices, notifications, broadcasts, SOS, incidents.
- Personnel: login, permitted admin actions, restricted actions, SOS/incident visibility.
- Admin: account management, access requests, SOS operations, incident operations, reports, broadcasts.

Confirm:

- Existing endpoint paths and response envelopes remain unchanged.
- Numeric `id` fields remain stable.
- Ownership filters remain enforced.
- Missing/invalid tokens return `401`.
- Insufficient permissions return `403`.
- Sent broadcasts cannot be edited or deleted.
- MongoDB `_id` is never returned.

## Gate 5 — Mobile and browser smoke tests

Against a development backend using Atlas:

1. Create a Firebase account and complete profile setup.
2. Confirm a `user_profiles` document is created.
3. Register a device token.
4. Create contacts and a friend request.
5. Send and resolve an SOS.
6. Submit an incident with evidence.
7. Confirm notifications and broadcast inbox results.
8. Log in as personnel and admin.
9. Verify permission-restricted controls.
10. Verify logout, refresh, and expired-session behavior.

Record request/output references or screenshots. Mocked tests do not count as browser evidence.

## Gate 6 — Fallback audit

Search remaining PostgreSQL calls:

```powershell
rg -n "pool\\.query|pool\\.connect|FROM users|FROM admins|incident_reports|sos_threads|admin_requests" src server.js
```

Classify every result as:

- Required rollback fallback.
- Migration tooling.
- Startup/health diagnostic.
- Test-only fixture.
- Runtime path that still needs migration.

Do not remove a call until its Mongo replacement has passing Atlas coverage.

## Gate 7 — Staging fallback removal

1. Disable fallback only in staging through the existing Mongo connection check.
2. Start the backend with Atlas configured.
3. Run the mobile and admin smoke tests again.
4. Monitor errors and Mongo writes.
5. Keep the PostgreSQL branch available in version control for rollback.

Do not add a new repository layer, queue, feature-flag framework, or second authorization system.

## Gate 8 — Rollback rehearsal

Using disposable databases:

1. Restore the PostgreSQL backup.
2. Re-enable the PostgreSQL-backed configuration.
3. Run authentication, ownership, SOS, incident, notification, broadcast, and report checks.
4. Confirm response shapes and data remain valid.
5. Record the rollback time, commands, and result.

## Completion criteria

The migration gate passes only when:

- Atlas preflight succeeds.
- Import and rerun are idempotent.
- Counts, IDs, references, timestamps, grants, indexes, and counters match.
- Model and transaction checks pass.
- Backend tests pass.
- Mobile and browser evidence passes for all three roles.
- No unclassified runtime PostgreSQL path remains.
- Staging fallback removal and rollback rehearsal succeed.

Production cutover is a separate approval step after this gate.

