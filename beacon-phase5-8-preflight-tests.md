# Phase 5-8 alignment and pre-Phase-9 tests

Reviewed September 20, 2026 against beacon-checkpoint2-implementation-phases.md and the accepted Phase 7 refinement. Backend: beacon-backend. React: D:\Programming\beacon-admin. Registration means administrator-created personnel accounts; no new public signup screen is required.

## Current evidence

Phase 9 execution began on September 20, 2026. Backend operational permission gates and the remaining validation/audit fixes were applied; the backend suite passes. Frontend build passes, while the full frontend test run currently stalls after initial suites and requires follow-up isolation. Atlas and browser evidence remain unverified.

| Area | Assessment |
|---|---|
| Phase 5 | Core implementation aligned: Mongo-backed broadcasts/deliveries, shared transaction with retry, post-commit pushes, draft CRUD, recipient isolation and admin-only deletion. Request validation still has gaps. |
| Phase 6 | Aligned: ReportRun inserts and latest-run lookup use MongoDB; generated_at is a Date; analytics/CSV still query PostgreSQL; no new history endpoint. Actual historical-data parity is unverified in this review. |
| Phase 7 | Planned UI and auth changes are present. Focused tests pass, but browser persistence and session-transition evidence remain required. |
| Phase 8 | Partially aligned: Helmet, malformed-JSON handling, custom limiters, and structured audit logging exist. Permission coverage, denial audit coverage, and request validation need completion. |

Executed: npm.cmd test in the backend: **208 passed, zero failed**. Focused React run: **42 passed across seven files** (broadcast controller/view, auth provider, API wrapper, login, managed account controller/API). These are current-run results, not carried forward from previous reviews.

React production build: **passed**, with a non-blocking bundle-size warning. The complete frontend suite was not run in this review.

The isolated Atlas checks passed in the earlier Phase 1-5 fix pass, but were not rerun during this review. Do not treat that historical result as verification of every current change.

## Confirmed gaps to resolve

1. **Permission checks are incomplete.** All report endpoints in src/routes/adminReportsRoutes.js and SOS administration/stream endpoints in src/routes/adminSosRoutes.js use authentication without an operational permission check. An active personnel account with no operational grants can reach these handlers. This conflicts with the plan's assigned-permissions rule. Map them to the approved existing permission matrix and enforce it server-side before querying or mutating data.
2. **Empty/non-object broadcast updates are accepted.** A local handler probe reproduced HTTP 200 for both PATCH bodies [] and {} on an all-audience draft. The route treats arrays as objects and adds audience unsets even when no editable field was supplied. Reject these bodies with 400 before touching MongoDB or emitting an edited audit event. Location: src/routes/broadcastRoutes.js, body normalization and no-updatable-fields check.
3. **Filter and public-ID validation is inconsistent.** Broadcast list accepts invalid sent filters by ignoring them; publish uses Number.isInteger instead of Number.isSafeInteger. Verify and reject malformed filters and unsafe IDs consistently with the plan.
4. **Audit coverage is incomplete.** Missing/invalid/expired tokens exit requireAuth without an audit event; the direct non-admin broadcast deletion rejection also bypasses the permission middleware's denial audit. Successful-password login for a deactivated account returns before recording its outcome. Log sanitized outcomes at these exits and verify retained output, not only the audit helper in isolation.
5. **Session regression coverage is missing.** Current auth-provider tests verify permissions only. They do not prove logout/cache clearing, auth:logout handling, expired-session redirect, or rejection of late profile responses. These are acceptance gaps, not assertions that the implementation is broken.

## Required test set

Use isolated development data and stub external pushes. Record test ID, expected result, actual result, command/evidence, and pass/fail. Rows below are acceptance cases, not claims that they have all run.

| ID | Scenario | Expected result | Test level |
|---|---|---|---|
| P5-01 | Create/list/edit/delete an unsent broadcast | Numeric ID and response shapes preserved; only requested content fields change; deleted draft disappears | API + actual React browser |
| P5-02 | Modern multi-role and legacy role-ID audiences; edit title/body/severity | Correct recipients; edit preserves audience exactly | API/controller + isolated DB |
| P5-03 | Admin vs personnel with manage_broadcasts; sent edit/delete | Authorized admin can delete a draft; personnel receives 403 even with broadcast permission; sent mutations return 409 | Full HTTP middleware chain |
| P5-04 | Concurrent send/send and send/publish | One successful commit, other attempt reports already sent; unique recipient deliveries; existing envelopes remain distinct | Real MongoDB transaction + HTTP |
| P5-05 | Delivery insertion fails within send transaction | No new send marker or partial recipient batch commits; no pushes attempted | Isolated MongoDB |
| P5-06 | Push lookup/batch/cleanup fails; 501 tokens | Send remains committed; warning/counts truthful; batches at most 500; later batches attempted | Service tests with Firebase stub |
| P5-07 | Acknowledge twice; acknowledge another recipient's delivery | First timestamp preserved; other recipient cannot modify it | Isolated MongoDB + authenticated route |
| P6-01 | Generate daily/weekly/monthly reports | Correct report_key/range_key, timezone, actor and native Date persisted; response timestamps remain ISO strings | Route test + isolated MongoDB |
| P6-02 | Multiple runs, different timezones, empty history | Latest timestamp chosen for each report/range/timezone; no timezone leakage; absent history returns null | Route test + isolated MongoDB |
| P6-03 | Compare overview and CSV against fixed PostgreSQL fixtures | Same KPIs, chart values, rows and response structure; report history comes from MongoDB | Existing report suite + baseline comparison |
| P7-01 | Draft CRUD in real React application, refresh after each step | Changes persist through reload; dialogs retain invalid input, cancel cleanly and prevent duplicate submits | Browser against development backend |
| P7-02 | API returns 400/401/403/404/409/422/429; network error and timeout | HTTP status/data preserved; stale drafts refresh/close; validation stays visible; timeout/network remain distinct | Actual API wrapper + controller |
| P7-03 | Login -> profile fetch -> dashboard; logout -> Back/refresh | Navigation waits for current profile; credentials/auth/cache cleared on logout; protected data remains inaccessible | Provider/router tests + browser |
| P7-04 | Expired-token 401 event; delayed old profile response; switch accounts | Single logout flow; redirect; old response cannot restore previous user or cache | Provider/API integration tests |
| P7-05 | Create personnel through existing management dialog; login as new account | Creation requires manage_admins; duplicate/invalid input rejected; bcrypt hash stored, no password/hash returned; new account logs in | React/browser + backend contract |
| P7-06 | Committed broadcast with push.error/unknownCount | UI says sent with delivery warning; does not claim everyone received it or invite resend | Controller/view test |
| P8-01 | Admin/personnel/citizen allowed and denied operations, including reports and SOS SSE | Appropriate permissions required server-side; missing/expired auth 401, insufficient grants 403; citizen can use own permitted mobile paths | Full HTTP tests + actual permission fixtures |
| P8-02 | Attempt role elevation during signup; recipient accepts own admin request | Signup remains low privilege; unauthorized promotion denied; legitimate recipient workflow preserved | Auth/admin-request contracts |
| P8-03 | Malformed JSON, null/array/empty PATCH, injected objects, bad enum, unsafe ID, invalid sent filter | Controlled 400/422 validation failure; no database mutation or success audit; no internal details | Full HTTP + model tests |
| P8-04 | Login/signup/write limit exceeded; successful and error responses | 429 at configured limit; Helmet headers present; response payloads contain no unintended secrets or stack traces | Existing HTTP suite + expanded cases |
| P8-05 | Audit auth outcomes, denials, management changes, draft mutations, send/publish and report generation | Retained structured records contain time/actor/action/target/outcome; no passwords, tokens, connection strings or raw bodies | Capture real handler logs + retention check |

## Commands

Backend tests (from beacon-backend):

```powershell
npm.cmd test
```

React tests and build (from beacon-admin):

```powershell
npm.cmd test -- --maxWorkers=1
npm.cmd run build
```

Repeat the currently focused React gate:

```powershell
npm.cmd test -- --maxWorkers=1 src/controllers/useBroadcastsController.test.jsx src/views/broadcasts/BroadcastsView.test.jsx src/auth/AdminAuthProvider.test.jsx src/services/api.test.js src/pages/Auth.test.jsx src/controllers/useUsersController.test.jsx src/api/useUsers.test.jsx
```

Existing opt-in Atlas checks (from beacon-backend; requires authorized test-database access):

```powershell
$env:BEACON_RUN_MONGO_TESTS = '1'
node src/phase1-5.mongo.integration.test.js
Remove-Item Env:BEACON_RUN_MONGO_TESTS
```

That integration script creates/removes a uniquely named test database. It currently tests the shared send helper and synthetic migration records; it does not replace report-specific live tests, real PostgreSQL historical comparisons, or a browser demonstration. Do not run mongo:import against an authoritative application database to perform this gate.

## Proceed to Phase 9 when

Resolve confirmed permission/validation/audit gaps, pass the expanded targeted cases, complete the full frontend suite, and record browser evidence for CRUD/session/managed-registration behavior. Rebuild after fixes. Phase 9 then consolidates cross-feature regression and the final 23-item checklist evidence. Keep any unavailable live check explicitly pending.
