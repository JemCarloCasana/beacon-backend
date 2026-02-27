# Web Admin Broadcast Context

This document is the contract for building the web admin broadcast screen.
Goal: Admin creates and sends broadcasts that notify Android app users via FCM.

## Purpose

- Source of broadcast: Web admin dashboard.
- Recipients: Android app users (`users` + `devices`), not admin accounts.
- Delivery storage: `broadcast_user_deliveries`.

## Auth

- Web admin endpoints require admin JWT:
  - Header: `Authorization: Bearer <admin_jwt>`
  - Issued by: `POST /admin/auth/login`

## Core Endpoints For Broadcast Screen

### 1) Create draft broadcast

- `POST /admin/broadcasts`
- Permission: `manage_broadcasts`

Request:

```json
{
  "title": "Campus Advisory",
  "body": "Classes are suspended due to weather conditions.",
  "severity": "high",
  "audience_type": "all",
  "audience_role_ids": [1, 2]
}
```

Rules:

- `title`: required string
- `body`: required string
- `severity`: one of `info | medium | high | critical`
- `audience_type`: one of `all | role`
- `audience_role_ids`: required non-empty integer array only when `audience_type = "role"`

Response:

- `201` with inserted `broadcasts` row (`sent_at = null` means draft)

### 2) List broadcasts (draft + sent)

- `GET /admin/broadcasts`
- Optional filter:
  - `?sent=1` sent only
  - `?sent=0` drafts only

Response:

- `200` array of `broadcasts` rows (newest first)

### 3) Send broadcast to Android app users

- Preferred: `POST /admin/broadcasts/:id/send`
- Permission: `manage_broadcasts`

Behavior:

- Marks broadcast as sent (`sent_at = NOW()`).
- Inserts recipients into `broadcast_user_deliveries`.
- Resolves role audience by matching:
  - `broadcasts.audience_role_ids` -> `roles.id`
  - `roles.name` (case-insensitive) == `users.role`
- Sends FCM to Android tokens from `devices` where:
  - `devices.platform = 'android'`
  - `devices.user_id` belongs to inserted recipients

Response:

```json
{
  "ok": true,
  "broadcast_id": 123,
  "sent_at": "2026-02-27T12:00:00.000Z",
  "delivered_count": 40,
  "push": {
    "successCount": 38,
    "failureCount": 2,
    "removedTokensCount": 1
  }
}
```

Status codes:

- `400` invalid id or payload
- `404` broadcast not found
- `409` broadcast already sent
- `500` server error

## Legacy Endpoint

- `POST /admin/broadcasts/:id/publish` exists and also sends.
- Frontend should use `/send` as primary action to avoid split behavior.

## Suggested Web Admin Screen Flow

1. Load drafts and sent broadcasts from `GET /admin/broadcasts`.
2. Create a broadcast draft via `POST /admin/broadcasts`.
3. Confirm send modal:
   - Show `title`, `severity`, and audience summary.
4. Send via `POST /admin/broadcasts/:id/send`.
5. Show send result:
   - `delivered_count` (DB recipients)
   - FCM `successCount/failureCount`

## Frontend Data Shape (Suggested TypeScript)

```ts
type Severity = "info" | "medium" | "high" | "critical";
type AudienceType = "all" | "role";

type Broadcast = {
  id: number;
  title: string;
  body: string;
  severity: Severity;
  audience_type: AudienceType;
  audience_role_ids: number[] | null;
  created_by_admin_id: number;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  is_active: boolean;
};

type SendBroadcastResponse = {
  ok: true;
  broadcast_id: number;
  sent_at: string;
  delivered_count: number;
  push: {
    successCount: number;
    failureCount: number;
    removedTokensCount: number;
  };
};
```

## Operational Notes

- `delivered_count` can be higher than `push.successCount` (invalid tokens, offline, etc.).
- Invalid FCM tokens are cleaned from `devices` after send.
- If frontend needs role labels, fetch from `roles` endpoint (if available) or provide static mapping until exposed.

