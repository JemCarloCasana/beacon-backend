# Mobile Signup and MongoDB Route Fix Plan

## Goal

Make mobile signup complete and move its profile flow to MongoDB without breaking existing features. Firebase creates the authentication account; Beacon must also persist and read the user's profile in the database used by its runtime routes.

## 1. Confirm the failure before changing persistence

Capture the status and sanitized response from the mobile `POST /me/bootstrap` call and the matching backend log. Confirm the app calls the intended backend with a fresh Firebase ID token. Distinguish `400` validation, `401` token, `429` rate limit, database `500`, and a network failure. A Firebase account being created does not identify which of these failed.

The current `/me/bootstrap` and `requireAppAuth` both write PostgreSQL. The route validates `full_name` as ASCII letters and spaces, phone as a Philippine number, and role as `citizen` or `student`. Fix a confirmed validation or network error at its source first; a database rewrite alone will not fix it.

## 2. Verify the MongoDB target

Confirm that the running backend and the completed import refer to the **same intended database**. The importer can select `MONGO_DISPOSABLE_DB_NAME`, while server startup calls `connectMongo()` without that override. Check the effective database names without logging connection strings or credentials.

In that database, verify imported user IDs, Firebase UIDs, role/status values, timestamps, Beacon Codes, the `users` counter, and unique indexes. Confirm email normalization and collision handling against actual imported records. Stop PostgreSQL reimports before MongoDB begins receiving new profile writes: the current importer upserts by public ID and can overwrite newer MongoDB values.

## 3. Choose a consistent runtime boundary

The existing PostgreSQL contacts, friendships, devices, SOS events/threads, and incident reports reference `users.id`. Creating a profile only in MongoDB leaves no PostgreSQL user row for those writes and can violate foreign keys. Merely changing their UID lookups to MongoDB does not solve this.

For the permanent MongoDB switch, migrate each dependent feature's complete reads and writes before allowing new Mongo-only users:

1. Profiles, contacts, friend requests, friendships, devices, and their push recipient lookups.
2. SOS and incident records, events/evidence, admin views, and report source queries.
3. Remaining user/admin joins and broadcast/notification recipient resolution.

Keep numeric public IDs and existing API responses. Until this boundary passes, keep the active PostgreSQL identity path working for mobile users. Do not claim a MongoDB-only runtime while those routes still use PostgreSQL.

## 4. Implement profile creation at the coordinated switch

Update `requireAppAuth` and `/me/bootstrap` together to use `UserProfile`. Share one creation rule so concurrent first requests cannot create duplicate profiles:

- Look up by Firebase UID; assign a new `public_id` from the existing `users` counter only on insert.
- Generate a Beacon Code only when missing; retry an actual duplicate-code conflict, not an unrelated duplicate email or UID.
- Preserve imported IDs, codes, statuses, and timestamps.
- Validate and explicitly set profile fields. Keep the token-derived provisional profile behavior separate from the completed signup fields so a later request does not undo the submitted name, role, or phone.
- Map `public_id` to the API's numeric `id`; never return MongoDB `_id`.
- Preserve current response fields and status codes. Decide and test deactivated-user behavior from the existing contract; do not add a new denial rule accidentally.

Move `GET /me`, `PATCH /me`, `GET /users`, and user search in the same switch. User search's friendship status must read the migrated friendship/request collections, not a PostgreSQL join.

## 5. Verify at each boundary

- Reproduce the original mobile error and show the corrected request succeeds.
- Create a new Firebase account and verify one profile with a stable numeric ID and Beacon Code after repeated bootstrap calls and restart.
- Test concurrent first requests, Beacon Code collisions, invalid input, ownership, and deactivated-account behavior.
- Test signup followed by contacts, friends, device registration, SOS, incident submission, notifications, and broadcasts. These must work for a **new** user who never had a PostgreSQL row.
- Compare API response fields and status codes with current clients. Replace PostgreSQL-specific route test stubs with MongoDB tests where the route actually changes; run the backend suite and focused Atlas checks against a disposable database.
- Search active runtime paths for remaining PostgreSQL user/admin dependencies and record which domains still use PostgreSQL. Do not infer completion from data parity alone.

## Rollback

Preserve the PostgreSQL source and the pre-switch application revision. Reverting code is safe only before MongoDB-only writes occur. After such writes, restore or reconcile the new records before returning to PostgreSQL-backed routes; otherwise the rollback loses newly registered users and their activity.

## Completion

The signup issue is fixed when the mobile app completes profile signup and the new account can use the dependent features. The full MongoDB migration is complete only when no active runtime route requires PostgreSQL, the imported and newly created records pass integration checks, and the switch/rollback evidence reflects the actual deployed configuration.
