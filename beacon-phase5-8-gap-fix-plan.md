# Phase 5-8 Gap Fix Plan

This plan resolves the confirmed gaps in [beacon-phase5-8-preflight-tests.md](beacon-phase5-8-preflight-tests.md) before Phase 9. It keeps the current polyglot design, permission middleware, Mongoose models, custom rate limiter, React Query structure, and existing API contracts.

## Implementation status

Completed in the backend workspace:

- Broadcast list rejects invalid `sent` filters.
- Broadcast draft updates reject null, array, and empty request bodies before database mutation.
- Admin login and admin-auth failures now emit sanitized audit outcomes.
- Direct personnel deletion denial is audited.

Still required before Phase 9:

- Add and test explicit report/SOS operational permission gates using deployed permission names.
- Add focused regression tests for the new validation and audit behavior.
- Complete React session/browser verification in `D:\Programming\beacon-admin`.
- Run the dedicated Atlas and browser acceptance checks.

## Fix order

| Step | Gap | Completion gate |
|---|---|---|
| 1 | Server-side permission coverage | Personnel without the required permission receives 403 for reports and SOS operations; permitted roles still work. |
| 2 | Broadcast PATCH validation | `{}`, `[]`, `null`, unknown fields, unsafe IDs, and invalid filters return 400 without Mongo writes or success audit entries. |
| 3 | Consistent public-ID/filter validation | Broadcast list, publish, edit, delete, report, and SOS routes reject non-positive, unsafe, or malformed values consistently. |
| 4 | Audit coverage | Authentication failures, role denials, deactivated-login attempts, and direct deletion denials emit sanitized audit records. |
| 5 | React session regression coverage | Logout, `auth:logout`, expired sessions, cache clearing, and stale profile responses are proven by tests and browser checks. |
| 6 | Full acceptance gate | Backend tests, full React tests, build, focused Atlas checks, and browser evidence pass before Phase 9. |

## 1. Complete backend permission enforcement

Use the existing `requirePermission` middleware and permission names already present in the database. Do not add a second role or authorization framework.

- Map report overview, report generation, and CSV export to the approved report-view/generate permissions. Use the existing project permission names where available; if the database has no separate report permission, document the chosen existing operational permission and apply it consistently.
- Map SOS live map/list/stream, acknowledge, resolve, and detail routes to their approved SOS permissions. The SSE handshake must run the same permission checks before opening the stream.
- Keep `requireAdminAuth` before `requirePermission`, so missing/invalid tokens return 401 and authenticated insufficient users return 403.
- Preserve citizen/mobile ownership rules; do not use admin permissions on Firebase-authenticated routes.
- Add route tests for admin allowed, personnel allowed with the grant, personnel denied without the grant, and missing/expired tokens.

## 2. Reject invalid broadcast updates before mutation

Update the existing PATCH handler in `src/routes/broadcastRoutes.js` at the request boundary.

- Accept only a non-null, non-array plain object.
- Reject an empty body and unknown fields with 400.
- Keep the editable allowlist limited to `title`, `body`, and `severity` for the React Phase 7 flow. Preserve audience fields by leaving them untouched.
- Validate trimmed title/body lengths and allowed severity values before querying or updating MongoDB.
- Keep the atomic `{ public_id, sent_at: null, audience snapshot }` filter so concurrent sends or audience changes return 409.
- Return 404 for a missing record, 409 for a sent or concurrently changed record, and 400 for caller input errors.
- Emit `broadcast.edited` only after a successful update.

Add tests proving `{}`, `[]`, `null`, unknown fields, oversized fields, invalid severity, and valid edits. Assert that invalid cases do not call `findOneAndUpdate` and do not emit audit logs.

## 3. Normalize ID and query validation

Create one small local positive-safe-integer parser or reuse the existing parser at each affected route; do not introduce a generic validation package.

- Use `Number.isSafeInteger(value) && value > 0` for broadcast, report, incident, SOS, and notification public IDs where numeric IDs are part of the API.
- Reject unsafe values instead of silently coercing them.
- Validate `GET /admin/broadcasts?sent` as only absent, `0`, or `1`; return 400 for other values.
- Make publish use the same safe-integer rule as send/edit/delete.
- Validate report range/timezone and existing query filters without changing their response format.

Test decimal, zero, negative, `NaN`, exponent overflow, arrays, objects, and unknown filter values through the actual HTTP route chain.

## 4. Fill audit gaps safely

Extend `src/utils/auditLog.js` usage without logging secrets or raw request bodies.

- In `requireAuth`, emit sanitized outcomes for missing, malformed, expired, unknown-account, and deactivated-account tokens. Avoid logging the token itself.
- Ensure the broadcast direct role check uses `auditLog` before returning its 403 response, including actor ID and target route.
- Record deactivated-account login attempts as a distinct `admin.login` outcome before returning 403.
- Keep existing permission-denial, account-management, broadcast, and report events.
- Use stable action/target/outcome fields and retain only sanitized details.

Capture console output in tests and assert timestamp, actor, action, target, and outcome. Assert that passwords, JWTs, authorization headers, connection strings, and raw request bodies never appear.

## 5. Complete React session and browser checks

Target `D:\Programming\beacon-admin` and reuse the existing provider, Query Client, API wrapper, and broadcast hooks.

- Add provider tests for explicit logout, the `auth:logout` event, expired-token handling, query cancellation/cache clearing, and a late `/admin/me` response after logout.
- Verify login waits for the current `/admin/me` response before navigating and that a newer token cannot be overwritten by an older response.
- Keep permission checks based on backend `/admin/me` permissions; verify admin does not receive injected permissions.
- Run the full Vitest suite, not only the focused seven-file selection, then run the production build.
- In a development browser session, create, reload, edit, reload, delete, and reload a draft. Verify sent records have no edit/delete controls, personnel cannot delete, invalid input stays visible, and 404/409 responses refresh stale data.
- Create a personnel account through the existing admin management dialog, log in as that account, log out, use browser Back/refresh, and verify protected routes remain inaccessible.

No new public signup screen, auth system, cache layer, or browser automation dependency is required.

## 6. Phase 9 entry test set

Run these in order and record command, environment, expected result, actual result, and pass/fail:

1. Backend `npm.cmd test`.
2. Targeted backend tests for reports/SOS permission gates, broadcast invalid updates, safe IDs/filters, audit outcomes, and response secrecy.
3. React full test suite: `npm.cmd test -- --maxWorkers=1` from `beacon-admin`.
4. React production build: `npm.cmd run build`.
5. Opt-in Atlas test database checks for report-run persistence, native `Date` sorting, latest-run scoping, broadcast transaction concurrency, unique indexes, and rollback. Remove the generated test database afterward.
6. Browser checks for Phase 7 CRUD, managed registration, login/logout, expired session, and personnel/admin permission behavior.
7. Regression checks for SOS, incidents, friendships, notifications, broadcasts, and reports against the existing API shapes.

Phase 9 may start only when the five confirmed gaps are fixed, all available tests pass, the React build passes, and browser/Atlas evidence is recorded. If live Atlas or browser access is unavailable, keep those items explicitly unverified rather than marking Phase 9 complete.

## Deferred work

Do not expand this fix into deployment, a new audit database/UI, a new validation framework, a report-history endpoint, public signup, or a redesign. Those remain outside the Phase 5-8 gap closure.
