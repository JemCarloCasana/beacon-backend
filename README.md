# Beacon Backend API

## Auth Overview

This backend uses two auth systems:

- Mobile/app user APIs: Firebase ID token (`Authorization: Bearer <firebase_id_token>`)
- Admin dashboard APIs: backend-issued admin JWT (`Authorization: Bearer <admin_jwt>`)

## Protected Route Boundaries

- Firebase-protected app routes:
  - `GET/PATCH /me`
  - `POST /me/bootstrap`
  - `GET /users` (current user alias)
  - `POST /devices/register`
  - `GET/POST/PATCH/DELETE /contacts*`
  - `GET/POST/DELETE /friends*`
  - `POST /sos`
  - `POST /incidents`
  - `GET /admin/broadcasts/my/inbox`
  - `POST /admin/broadcasts/:id/ack`
- Admin JWT + permission-protected routes:
  - `GET /admin/me`
  - `POST /admin/admins`
  - `GET /admin/users/:id`
  - `PATCH /admin/users/:id`
  - `PATCH /admin/admins/:id`
  - `POST /admin/broadcasts`
  - `POST /admin/broadcasts/:id/send`
  - Other `/admin/*` management routes guarded with `requirePermission(...)`
- Public routes:
  - `GET /health`
  - `GET /health/db`
  - `GET /users/:id/public`
  - `POST /admin/auth/login`
  - `POST /admin/auth/signup`

## Firebase Auth Behavior

- Middleware verifies Firebase ID token each request (`verifyIdToken`).
- On valid Firebase token, app routes auto-bootstrap a `users` row (if missing) using:
  - `firebase_uid` as identity key
  - email from token (or fallback `<uid>@firebase.local`)
  - full name from token name/email fallback
  - generated unique `beacon_code`
- Auth failures are logged without token leakage and counted in auth metrics.

## Authorization Behavior

- Missing/invalid token: `401`
- Insufficient permission: `403`
- Admin permission checks come from role-permission tables.
- Firebase token checks optionally verify revocation if `FIREBASE_CHECK_REVOKED=true`.

## Error Contract

- `401`: Missing Bearer token, invalid/expired token, unauthorized identity
- `403`: Authenticated but lacks role/permission
- `404`: Resource not found
- `409`: Conflict (duplicate constraints / already processed resources)
- `429`: Rate limit exceeded
- `500`: Unexpected server error

## Security Hardening in Server

- CORS allowlist via `CORS_ORIGINS` and `ADMIN_FRONTEND_URL`
- Rate limits on auth-sensitive and high-impact endpoints
- Firebase credentials loaded from environment/secret paths (no hard-coded key file path)

## Required Environment Variables

- `DATABASE_URL`
- `ADMIN_JWT_SECRET`
- Firebase Admin credential strategy (pick one):
  - `FIREBASE_SERVICE_ACCOUNT_JSON` (raw JSON string)
  - `FIREBASE_SERVICE_ACCOUNT_PATH` (path to JSON file injected by secrets manager)
  - or workload identity / ADC with `GOOGLE_APPLICATION_CREDENTIALS`

Recommended:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CHECK_REVOKED=true|false`
- `CORS_ORIGINS=https://app.example.com,https://admin.example.com`
- `AUTH_RATE_LIMIT_WINDOW_MS`
- `AUTH_RATE_LIMIT_MAX`
- `ACTION_RATE_LIMIT_WINDOW_MS`
- `ACTION_RATE_LIMIT_MAX`

## Operations Checklist

- Keep Firebase service credentials outside source control.
- Rotate leaked local secrets before production deploy.
- Restrict CORS origins per environment.
- Monitor `GET /health/auth-metrics` for:
  - invalid token rate
  - auth failure count
  - auth verification latency (`avgVerifyMs`)
- Ensure production logs do not include raw bearer tokens.

## Quick Curl Example

```bash
curl -X GET http://localhost:3000/me \
  -H "Authorization: Bearer <FIREBASE_ID_TOKEN>"
```
