# Web Admin SOS Live Operations Context

This document is the frontend contract for the web admin SOS live-operations module.
Goal: Let admin operators monitor active SOS cases in real time, inspect details/history, and take acknowledge/resolve actions.

## Purpose

- Source of SOS: Mobile app (`POST /sos`).
- Admin consumer: Web admin dashboard.
- Persistence: `sos_events` (event-log model).
- Thread key: `sos_id` (root event id for a case/thread).

## Auth

All SOS admin endpoints require admin JWT:

- Header: `Authorization: Bearer <admin_jwt>`
- Token source: `POST /admin/auth/login`

No additional permission gate is currently required (auth-only).

## Status Lifecycle

Allowed status values used by live ops:

- `active`
- `acknowledged`
- `resolved`

Model:

- Status transitions append new rows in `sos_events`.
- Existing rows are not overwritten for lifecycle updates.

## Core Endpoints

### 1) Live queue

- `GET /admin/sos/live`

Query params:

- `status` optional: `open | active | acknowledged | resolved`
  - default: `open` (active + acknowledged)
- `limit` optional (default 100, max 500)
- `cursor` optional (pagination cursor)

Response: array of thread summaries.

```json
[
  {
    "sos_id": 123,
    "user_id": 45,
    "full_name": "Juan Dela Cruz",
    "phone_number": "+639171234567",
    "role": "student",
    "latest_status": "active",
    "latest_message": "Need help",
    "latest_latitude": 16.0431,
    "latest_longitude": 120.3333,
    "latest_address": "Dagupan City",
    "opened_at": "2026-02-27T10:00:00.000Z",
    "latest_event_at": "2026-02-27T10:01:12.000Z",
    "acknowledged_at": null,
    "resolved_at": null
  }
]
```

Pagination:

- If more results exist, backend sets `X-Next-Cursor` header.
- Pass header value back as `?cursor=<value>` for next page.

### 2) Thread detail + timeline

- `GET /admin/sos/:sosId`

Response:

```json
{
  "thread": {
    "sos_id": 123,
    "user_id": 45,
    "full_name": "Juan Dela Cruz",
    "phone_number": "+639171234567",
    "role": "student",
    "latest_status": "acknowledged",
    "latest_message": "Responder en route",
    "latest_latitude": 16.0431,
    "latest_longitude": 120.3333,
    "latest_address": "Dagupan City",
    "opened_at": "2026-02-27T10:00:00.000Z",
    "latest_event_at": "2026-02-27T10:03:10.000Z",
    "acknowledged_at": "2026-02-27T10:03:10.000Z",
    "resolved_at": null
  },
  "events": [
    {
      "id": 9001,
      "sos_id": 123,
      "user_id": 45,
      "status": "active",
      "latitude": 16.0431,
      "longitude": 120.3333,
      "address": "Dagupan City",
      "message": "Need help",
      "created_at": "2026-02-27T10:00:00.000Z",
      "actor_type": "user",
      "actor_admin_id": null
    }
  ]
}
```

### 3) Acknowledge action

- `POST /admin/sos/:sosId/acknowledge`

Body (optional):

```json
{ "note": "Responder assigned" }
```

Behavior:

- Latest `active` -> appends `acknowledged` event.
- Latest already `acknowledged` -> idempotent success.
- Latest `resolved` -> `409`.

Response:

```json
{
  "ok": true,
  "sos_id": 123,
  "latest_status": "acknowledged",
  "acknowledged_at": "2026-02-27T10:03:10.000Z",
  "latest_event_at": "2026-02-27T10:03:10.000Z"
}
```

### 4) Resolve action

- `POST /admin/sos/:sosId/resolve`

Body (optional):

```json
{ "note": "Case closed" }
```

Behavior:

- Latest `active|acknowledged` -> appends `resolved` event.
- Latest already `resolved` -> idempotent success.

Response shape is same as acknowledge.

### 5) Live stream (SSE)

- `GET /admin/sos/live/stream`

Server-sent event types:

- `snapshot`: full open-thread list (on connect and every ~30s)
- `delta`: one changed thread (new SOS, acknowledge, resolve)

Reconnect support:

- Send `Last-Event-ID` header on reconnect.
- Backend replays buffered events for ~5 minutes.
- If replay window missed, backend still sends fresh snapshot.

### 6) Map compatibility feed

- `GET /admin/sos/live-map`

Purpose:

- Backward-compatible map endpoint.
- Returns latest active location per user.
- Excludes null latitude/longitude.

## Error Contract

- `400`: invalid params/body (e.g., bad `sosId`, bad `status`, bad `note` type)
- `401`: missing/invalid admin JWT
- `404`: SOS thread not found
- `409`: invalid transition (e.g., acknowledge after resolved)
- `500`: server error

## Suggested Web Admin Screen Flow

1. Open SOS Live Ops page.
2. Load initial queue with `GET /admin/sos/live` (default `status=open`).
3. Open SSE stream `GET /admin/sos/live/stream`.
4. On `snapshot`, replace open-list state.
5. On `delta`, upsert affected thread in list/state.
6. On selecting a thread, fetch details via `GET /admin/sos/:sosId`.
7. Acknowledge/resolve from detail pane using action endpoints.
8. Keep map widget fed from `GET /admin/sos/live-map` (or thread data).

## Frontend Data Types (Suggested TypeScript)

```ts
type SosStatus = "active" | "acknowledged" | "resolved";

type SosThread = {
  sos_id: number;
  user_id: number;
  full_name: string;
  phone_number: string | null;
  role: string;
  latest_status: SosStatus;
  latest_message: string | null;
  latest_latitude: number | null;
  latest_longitude: number | null;
  latest_address: string | null;
  opened_at: string | null;
  latest_event_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
};

type SosEvent = {
  id: number;
  sos_id: number;
  user_id: number;
  status: SosStatus;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  message: string | null;
  created_at: string;
  actor_type: "user" | "admin" | "system";
  actor_admin_id: number | null;
};

type SosDetailResponse = {
  thread: SosThread;
  events: SosEvent[];
};

type SosActionResponse = {
  ok: true;
  sos_id: number;
  latest_status: SosStatus;
  acknowledged_at: string | null;
  latest_event_at: string;
};
```

## Operational Notes

- Queue uses latest event per `sos_id` thread.
- A thread can remain visible in `open` when status is `acknowledged`.
- `resolved` threads are excluded from default open queue.
- Stream is additive to REST, not a replacement for initial data fetch.
- If SSE fails, frontend should fall back to periodic `GET /admin/sos/live` polling.
