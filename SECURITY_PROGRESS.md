# Implementation ledger - plan: SECURITY_IMPLEMENTATION.md

Baseline: existing Dagupan backend/admin/mobile changes and profile UI fixes retained. New security-hardening branch approved by execution review.
Ruling: work in the existing checkout on a dedicated branch because three repositories contain uncommitted approved work; a clean worktree would omit it. No automatic commits or deployment.
Ruling: keep a permanent verification ledger rather than shell-only skill scaffolding; the supplied plan has no task-script format or commit instructions.
Interfaces: backend live DTO feeds Android and admin; current SOS fields plus location_updated_at and can_close. Latest coordinates belong to Mongo; Firestore is best-effort server history.
Interfaces: token_version feeds request and SSE authentication; logout distinguishes explicit server invalidation from automatic local cleanup.
Interfaces: production credentials and URLs must be operator-supplied; never invent an endpoint or silently enable revoked-token checks with invalid credentials.

Task 1: implemented locally - permissions, deactivation, admin sessions.
Task 1: authentication regression checks RED to GREEN (5/5); existing backend suite passes after new token claim fixtures.
Task 2: live API authorization and invalid-coordinate/CAS regression checks RED to GREEN (8/8 combined).
Task 3: read-only Atlas inventory 2026-10-09 confirmed selected database test, TLS enabled, two profiles, eight reduced collections. Runtime account still atlasAdmin on admin: requires operator replacement; no records moved.
Task 3: production database/TLS guard regression RED to GREEN; separate URI and named disposable test database enforced. Exposed tracked credential removed from checkout and ignored. Current external credential fails OAuth (400); key revocation and IAM still require operator verification.
Task 2: Firestore emulator passed anonymous and authenticated client denial for SOS root, location history, phone mirror; backend Admin SDK writes and reads succeeded.
Task 4: Android direct Firestore calls and phone mirrors removed; backend polling every10 seconds; owner/location response guards and account-switch clearing added; debug unit tests and APK build passed. Device checks blocked: ADB lists no device.
Task 5: 8-hour JWT/version checks, logout and password atomic updates, bcrypt byte limit and guarded stream writes implemented. Regression checks pass for permission removal/version/expiry and incident races.
Admin: affected 18 tests passed; full baseline had 11 existing failures (notifications/Header/LiveSOS). Temporary test URLs used only to compile release artifacts; no production URL invented.
Ruling: production always checks revoked Firebase tokens; local checks remain opt-in until configured credentials pass validation. Invalid provider credentials return503 and keep sessions retryable.
Verification: Android debug and release unit tests/builds passed. Missing and HTTP release URLs fail validation as intended. Admin production build passes with HTTPS fixture; missing URL fails. Admin affected18/18 pass; full226/237 pass with the same11 baseline notification/Header/LiveSOS failures.
Fix: shared SOS services now accept internal ObjectId values while public IDs remain strings. Owner/friend live reads and outside-city successful tracking exposed the existing conversion error; checks RED to GREEN.
Final review: two Important findings fixed in one pass. Broadcast inbox/ack now reject deactivated profiles before reads/writes. Stream event writes are serialized per connection, replay is awaited before snapshots, and disconnected writers are closed without unhandled rejections. Three regressions RED to GREEN; security checks20/20 pass. No additional findings were reported.
Cutover: read-only dry-run on the inventoried application database test found zero admin accounts needing backfill and zero legacy SOS locations to recover. No cutover writes were performed.
Final verification2026-10-10: npm test passed (132 TAP tests, zero failures); Android debug/release each31 unit tests with zero failures/errors; affected admin18/18 passed and production build passed. Full admin226/237 passed;11 existing failures retained. Firestore emulator denied anonymous/authenticated client access and accepted backend access. No connected device, live integration-test credential, staging validation or deployment.
