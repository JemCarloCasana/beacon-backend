# Beacon security implementation

Contract: implement the user-approved Beacon Security Implementation Plan (2026-10-09).
Preserve MongoDB, Firebase authentication, Firestore history, existing permissions and Dagupan restrictions.

1. Backend permissions: administrator-created staff only; incident view/manage permissions; broadcast view permission; current recipient permissions; deactivated profile rejection; owner-only mobile closure; conditional incident status writes.
2. Live SOS: MongoDB latest location and timestamp; current owner/friend reads; owner-only active-case updates; backend Firestore history keyed by SOS ID; Android backend polling every 10 seconds; deny all direct client SOS and phone-mirror access.
3. Database: inventory before configuration changes; explicit production database, verified TLS, scoped runtime credentials; separate disposable test credentials; remove exposed credential from checkout; operator verifies revocation and Firebase IAM.
4. Transport/authentication: separate Android debug/release URLs, release HTTPS required; debug-only cleartext; admin production HTTPS; remove sensitive logs; distinguish 401/403/503; revoked-token checks require verified credentials.
5. Admin sessions: token_version, eight-hour JWTs, legacy token rejection; account-wide logout/password invalidation; 72-byte bcrypt limit; guarded stream writes and 15-second heartbeat revalidation.

APIs: GET /sos/live (active only, cursor default100/max500); GET /sos/:id/live (terminal states included); PATCH /sos/:id/location; POST /admin/auth/logout; POST /admin/auth/change-password.
Snapshots retain SOS field names and string IDs; add location_updated_at and can_close.

Acceptance: unauthorized calls have no writes/notifications; races return409; revoked access clears client data; temporary failures retain timestamped location; Firestore failure preserves accepted Mongo writes; existing emergencies track outside Dagupan.
Verification: backend tests, admin tests/build, Android tests/debug/release builds, Firestore emulator, connected-device checks. Staging and coordinated deployment remain release gates. Recover legacy locations only after SOS ID and Firebase owner match. No data moves, database renames, Git history rewrite, or deployment without concrete operator verification.
