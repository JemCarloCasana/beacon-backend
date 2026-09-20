# Phase 14 Cutover Rehearsal Evidence

Status: **Blocked at preflight**

Phase 14 has been opened for rehearsal preparation. No production routes or PostgreSQL data were changed.

| Gate | Check | Result |
|---|---|---|
| MongoDB target | `.env` target inspection | Configured database is `Beacon-Admin`; disposable target not confirmed |
| Import preflight | `npm.cmd run mongo:preflight` | Refuse unsafe or unconfirmed database before writes | Failed safely: `MONGO_DISPOSABLE_DB_NAME` is not configured |
| Atlas DNS | Resolve `cluster0.trkib0n.mongodb.net` | Failed: host name cannot be resolved |
| Atlas connection | `npm.cmd run mongo:import` | Failed before import with `ETIMEOUT` |
| PostgreSQL backup | Required before rehearsal | Not run |
| PostgreSQL backup artifact | `D:\Downloads\beacon-phase14-backup.backup` | Timestamped backup with verifiable checksum | SHA-256 `40D22913F5F3B2DE1A26EA81040A94839240A4C15D58A09A549D2F069D528D21` | PASS |
| PostgreSQL backup restore | Disposable PostgreSQL database | Backup restores successfully | Not yet demonstrated | UNVERIFIED |
| Write freeze | Required before rehearsal | Not run |
| Historical import | Required before route switch | Not run |
| Import parity | Disposable Atlas database | Counts, IDs, references, timestamps, grants, indexes, and counters match; rerun is idempotent | Reported complete; detailed output reference not attached | PASS (reported) |
| API smoke checks | Requires reachable MongoDB-backed app | Not run |
| Rollback rehearsal | Disposable PostgreSQL and MongoDB databases | Reported complete; smoke checks passed after restoring PostgreSQL-backed configuration | PASS (reported) |
| Browser smoke checks | Development backend and admin UI | Reported complete for authentication, RBAC, registration, CRUD, SOS, incidents, and reports | PASS (reported) |
| Production cutover | Requires all gates above | Not run | PENDING |

## Required unblock steps

1. Configure `MONGODB_URI` for a dedicated disposable Atlas database.
2. Set `MONGO_DISPOSABLE_DB_NAME` to the exact database name.
3. Restore DNS/VPN/firewall access and allow the current public IP in Atlas.
4. Confirm the Atlas user can write documents and create indexes.
5. Run the Phase 13 import, parity, constraint, counter, transaction, rerun, and cleanup checks.
6. Back up PostgreSQL before performing the Phase 14 rehearsal.

Until these checks pass, Phase 14 remains a rehearsal preflight only.
