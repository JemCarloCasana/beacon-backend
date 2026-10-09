# Beacon security rollout

Local implementation spans `beacon-backend`, `beacon-admin`, and `Beacon` (Android). Existing Dagupan restrictions and profile UI changes are retained. Do not release the clients independently of the backend and Firestore rules.

## Configuration and credentials

- Read-only inventory on 2026-10-09 confirmed the currently configured Atlas database is **test**, containing two profiles and the eight reduced collections. TLS is enabled. This is the application database, not a disposable test target. No records were moved or renamed.
- Set `MONGODB_DB_NAME` to the inventoried application database in deployment configuration. Production rejects a missing name, insecure TLS flags, or disposable database overrides.
- Replace the current `atlasAdmin` credential with a runtime account granting only `readWrite` on that application database. Supply tests with a different account through `MONGODB_TEST_URI` and an empty, explicitly named `MONGODB_TEST_DB_NAME` matching `beacon_test_[a-z0-9_]{8,64}`. Integration tests never use the runtime URI.
- The exposed Firebase key file was removed from the checkout. Git history still contains it; verify deletion/revocation in Firebase/Google Cloud IAM and coordinate history cleanup separately. Deleting the local file does not revoke a key.
- The currently configured external Firebase credential failed OAuth verification with HTTP400. Replace it outside Git, then run `node scripts/checkFirebaseCredentials.mjs`. Give the service account Firebase Authentication read/token-check access, required Firestore document operations, and push delivery access; remove broad project roles. IAM changes and actual key revocation remain operator work.
- Production checks Firebase token revocation. Locally set `FIREBASE_CHECK_REVOKED=true` only after credential verification succeeds. Provider failures return503; deactivation returns403 `ACCOUNT_DEACTIVATED`; invalid/revoked/expired tokens return401.
- Android reads `BEACON_DEBUG_API_URL` / `BEACON_RELEASE_API_URL` from Gradle properties or local.properties; release also supports the environment variable. Debug defaults to the existing local development URL. Release builds reject missing/HTTP URLs. Admin production builds require an HTTPS `VITE_API_BASE_URL`.
- Release compilation uses `https://example.invalid` only as a temporary validation fixture. Those artifacts are not configured for deployment.

## Cutover

1. Configure valid scoped Mongo/Firebase credentials and the real HTTPS API origins in staging. Verify API connectivity from both clients.
2. Run `node scripts/securityInventory.mjs` read-only. Review `node scripts/securityCutover.mjs` in dry-run mode. The apply mode (`--apply`) backfills absent admin token versions to0 and restores legacy points only after SOS ID and Firebase owner match MongoDB. It does not import legacy ownership or status. Unmatched records are preserved.
3. Apply the reviewed cutover in staging before deploying the backend. Existing admin tokens without a version claim require one new login. Logout and password changes invalidate every device for that account.
4. Deploy coordinated backend/admin/Android changes and the checked-in `firestore.rules`. The rules deny **all direct client Firestore access**, including nested SOS histories and the retired phone mirror. Do not combine them with an overlapping wildcard grant. Backend Admin SDK operations use IAM and bypass client rules. Inspect other Firebase clients before replacing a shared project's rules.
5. Verify staging: owner/current friend live reads, removed friend denial, owner/staff closure, active account enforcement, conflicting incident writes, logout across devices, revoked open streams, temporary provider/history outages, and real tracking after leaving Dagupan. Polling is10seconds; stream access checks run before data writes and every15seconds.
6. Install on a connected Android device; verify permissions/GPS, links, account changes, revocation, retries, and private-data clearing. ADB currently has no device. Older Android clients that write Firestore directly must update.

Keep restricted rules during rollback, preserve records and last known coordinates, and retain valid backend credentials. Do not restore public signup or the direct-client location path.

## Verification

- `npm test` passed (132 TAP tests, zero failures), including backend authorization/race/history/config regression checks. The live Mongo integration suite was not run because a separate test credential was unavailable; it never falls back to runtime credentials.
- `npx --yes firebase-tools emulators:exec --only firestore --project demo-beacon-security "node test/firestoreRules.emulator.test.mjs"`: anonymous and signed-in client reads/writes denied; backend operations succeeded.
- Android debug/release each passed31 unit tests and builds; missing and HTTP release URLs are rejected. Release validation uses a temporary HTTPS fixture.
- Admin affected permission/session tests18/18 and production compile passed. Full suite226/237 passed;11 existing notification/Header/LiveSOS failures are recorded separately in SECURITY_PROGRESS.md.
- Final review fixes are covered by regressions for deactivated broadcast access, ordered stream replay, and asynchronous stream write failures. Security checks20/20 pass.
- Atlas privilege replacement, Firebase key revocation/IAM, production rules, real configured endpoint smoke tests, staging and device checks are release gates; they have not been claimed as completed.
