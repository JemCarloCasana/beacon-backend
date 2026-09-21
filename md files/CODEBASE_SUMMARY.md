# Beacon Admin Codebase Summary

## Overview

This project is a React + Vite admin dashboard for public-safety operations. It is designed to help operators monitor incidents, coordinate live SOS requests, visualize emergency activity on a map, generate reports, and manage admin/user access.

The app is centered around operational awareness and response coordination, rather than generic admin tooling.

---

## Project Type

- Frontend: React 18
- Build tool: Vite
- Routing: React Router
- Data fetching: TanStack React Query
- Styling: Tailwind CSS + shadcn-style UI components
- Charts: Recharts
- Map: MapLibre
- Testing: Vitest + Testing Library

See [package.json](package.json) for the dependency and script configuration.

---

## High-Level Architecture

The project follows a clear layered pattern:

1. App shell and route configuration
2. Authentication and access control
3. API hooks and service layer
4. Controller/view-model logic
5. Page containers
6. View components and UI composition
7. Model transformation utilities

Key files:

- [src/App.jsx](src/App.jsx)
- [src/main.jsx](src/main.jsx)
- [src/auth/AdminAuthProvider.jsx](src/auth/AdminAuthProvider.jsx)
- [src/auth/ProtectedRoute.jsx](src/auth/ProtectedRoute.jsx)
- [src/services/api.js](src/services/api.js)
- [src/controllers](src/controllers)
- [src/pages](src/pages)
- [src/views](src/views)
- [src/models](src/models)

---

## App Structure

### Route-driven application

The main app shell in [src/App.jsx](src/App.jsx) registers routes for:

- `/login`
- `/dashboard`
- `/incidents` and `/incidents/:incidentId`
- `/sos` and `/sos/:sosId`
- `/alerts`
- `/map`
- `/reports`
- `/admin-requests`
- `/broadcasts`
- `/personnel`
- `/settings` redirect
- fallback `/404`

All protected areas use `ProtectedRoute` and permission checks where needed.

---

## Authentication and Authorization

Authentication is handled by [src/auth/AdminAuthProvider.jsx](src/auth/AdminAuthProvider.jsx). It:

- loads the current admin user from a persisted token
- sets an auth state for the whole app
- exposes helpers like `hasPermission`, `logout`, and `refreshMe`
- redirects expired or invalid sessions to `/login`

The route guard in [src/auth/ProtectedRoute.jsx](src/auth/ProtectedRoute.jsx) ensures:

- unauthenticated users are sent to login
- routes with `requiredPermission` deny access if the user lacks the permission

Permission-driven navigation is configured in [src/config/constants.js](src/config/constants.js), which defines menu items and optional access constraints.

---

## Shared API Layer

The backend communication layer is centralized in [src/services/api.js](src/services/api.js). It includes:

- base URL configuration from environment variables
- timeout handling
- automatic JSON parsing
- standard HTTP helpers (`apiGet`, `apiPost`, `apiPatch`, `apiDelete`)
- bearer token injection for `/admin` endpoints using `localStorage.admin_token`
- global error handling and 401 cleanup

This is the app’s main integration boundary with the backend.

---

## API Hooks and Data Access

The app organizes endpoint logic into React Query hooks under [src/api](src/api):

- `useIncidentsAPI` / related hooks for incident queries and mutation flows
- `useSOSAlerts`, `useSOSLiveQueue`, `useSOSDetail`, `useAcknowledgeSOS`, `useResolveSOS`
- `useReportsOverview`, `useGenerateReport`, `useExportReportCsv`
- user/admin/broadcast-related hooks

The exported API index is in [src/api/index.js](src/api/index.js).

The hooks are designed around real-time operations and polling intervals, especially for incident and SOS data.

---

## Controller Layer

The controller pattern is used for view-model composition, especially in [src/controllers](src/controllers).

Examples:

- [src/controllers/useDashboardController.js](src/controllers/useDashboardController.js)
- [src/controllers/useMapController.js](src/controllers/useMapController.js)
- [src/controllers/useUsersController.js](src/controllers/useUsersController.js)
- [src/controllers/useBroadcastsController.js](src/controllers/useBroadcastsController.js)

These controller hooks:

- compose API data with auth context
- normalize and filter data
- convert backend responses into UI-friendly shapes
- expose actions like navigation, state changes, and retry logic

This pattern keeps the page components thin and state logic centralized.

---

## Dashboard Module

The dashboard entrypoint is:

- [src/pages/Dashboard.jsx](src/pages/Dashboard.jsx)
- [src/views/dashboard/DashboardView.jsx](src/views/dashboard/DashboardView.jsx)
- [src/controllers/useDashboardController.js](src/controllers/useDashboardController.js)

The dashboard collects and shows:

- active incidents
- active SOS alerts
- KPI summaries
- reporter interaction details
- selected incident context
- quick navigation to incident, SOS, map, and personnel workspaces

It uses polling and refresh intervals to keep the overview live.

---

## Incidents Feature

The incidents workflow is implemented in:

- [src/pages/Incidents.jsx](src/pages/Incidents.jsx)
- [src/api/useIncidentsAPI.js](src/api/useIncidentsAPI.js)
- [src/models/incident.model.js](src/models/incident.model.js)

This area likely supports:

- list retrieval for incidents
- detail fetches for individual incidents
- status-based filtering
- update operations
- reporter identity context
- mapping-ready incident data

The file set also includes a component-style detail dialog and tests around incident behavior.

---

## Live SOS Feature

The live SOS flow is one of the app’s key operational modules.

Relevant files:

- [src/pages/LiveSOS.jsx](src/pages/LiveSOS.jsx)
- [src/api/useSosAPI.js](src/api/useSosAPI.js)
- [src/models/sos-live.model.js](src/models/sos-live.model.js)

This feature handles:

- live SOS queue retrieval
- open/dispatched/cancelled/resolved tab views
- automatic unit assignment based on emergency type
- acknowledgement actions
- resolution logic with notes and outcomes
- detail dialogs and route-based detail view

The SOS API layer explicitly validates assigned unit names and normalizes terminal outcomes such as cancelled or safe.

---

## Map Feature

The map view is implemented around:

- [src/pages/MapView.jsx](src/pages/MapView.jsx)
- [src/controllers/useMapController.js](src/controllers/useMapController.js)
- [src/lib/mapStyle.js](src/lib/mapStyle.js)
- [src/lib/mapMarkerStyles.js](src/lib/mapMarkerStyles.js)

It is designed around map-based situational awareness and likely shows incident/SOS points geographically using MapLibre.

---

## Reports and Analytics

Reports are handled in:

- [src/pages/Reports.jsx](src/pages/Reports.jsx)
- [src/api/useReportsAPI.js](src/api/useReportsAPI.js)
- [src/models/reports.model.js](src/models/reports.model.js)

Capabilities include:

- choose report ranges like 24h / 7d / 30d
- load KPI snapshots
- generate and export CSV reports
- display incident and SOS analytics charts
- show trends, status breakdowns, and category distributions

This is a more mature analytics module than a simple admin CRUD screen.

---

## Admin and User Management

There are also management features for:

- personnel / users: [src/pages/Users.jsx](src/pages/Users.jsx)
- admin requests: [src/pages/AdminRequests.jsx](src/pages/AdminRequests.jsx)
- broadcasts: [src/pages/Broadcasts.jsx](src/pages/Broadcasts.jsx)

These are permission-gated and align with the app’s emergency operations workflow.

---

## Data Models

The project contains a dedicated model layer under [src/models](src/models), which converts API data into front-end-friendly formats. Examples:

- [src/models/admin.model.js](src/models/admin.model.js)
- [src/models/incident.model.js](src/models/incident.model.js)
- [src/models/sos-live.model.js](src/models/sos-live.model.js)
- [src/models/reports.model.js](src/models/reports.model.js)
- [src/models/user.model.js](src/models/user.model.js)

This structure is a strong sign of separation between backend payloads and UI consumption logic.

---

## UI Components and Layout

The UI layer includes:

- layout wrappers and navigation: [src/components/layout](src/components/layout)
- dashboard-specific widgets: [src/components/dashboard](src/components/dashboard)
- low-level reusable UI: [src/components/ui](src/components/ui)
- map and incident visuals: [src/components/map](src/components/map)

The app uses a structured component library rather than ad hoc page code, which supports maintainability.

---

## Testing Strategy

There is substantial test coverage across the repo, including:

- API hook tests in [src/api](src/api)
- controller tests in [src/controllers](src/controllers)
- page tests in [src/pages](src/pages)
- model tests in [src/models](src/models)

This suggests the codebase is expected to validate both state logic and UI behavior before release.

---

## Operational Summary

From a product perspective, Beacon Admin is a real-time emergency operations dashboard for:

- monitoring incidents
- triaging and dispatching responses
- coordinating live SOS callers
- locating events on a map
- generating operational reports
- managing authorized personnel and admin actions

The app is not a generic business dashboard; it is intentionally tailored for public-safety response workflows.

---

## Strengths of the Codebase

- Clear separation of concerns
- Strong role-based access controls
- Real-time polling for live operational data
- Rich model transformation layer
- Good modularity across pages and controllers
- Good coverage of core behaviors via tests

---

## Potential Areas to Watch

- The app appears to rely heavily on environment-driven backend contracts, so API compatibility matters
- Real-time polling can create more complexity as data volume increases
- Permission checks and route gating should be maintained carefully as features grow
- Some modules may benefit from more explicit backend contract documentation if the API evolves

---

## Final Takeaway

Beacon Admin is a structured, production-style operations dashboard built for fast emergency-response coordination. It combines live data, role-based access, map visualization, and report generation into a cohesive interface tailored for monitoring and acting on public safety events.
