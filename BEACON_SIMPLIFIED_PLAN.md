# Beacon — Simplified Development Plan

## 1. Project Goal

Beacon is a **student safety and emergency response system**.

The simplified version focuses on three main purposes:

1. Allow students to quickly send an **SOS alert with their location**.
2. Allow students to **report safety incidents**.
3. Allow the school/LGU/admin to **monitor emergencies and send safety alerts**.

The goal of this simplification is to reduce unnecessary complexity and over-engineering while keeping the important features of Beacon.

---

## 2. Final Simplified Architecture

```text
                    BEACON

        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
  Android App      Express API     Admin Web
  Kotlin + XML       Node.js         React
        │              │              │
        └──────────────┼──────────────┘
                       │
                    MongoDB

Supporting Services:
- Firebase Authentication → Login and account authentication
- Firebase Cloud Messaging → Push notifications
- MapLibre + GPS → Maps and location
```

### Main Rule

**MongoDB is the main application database.**

Do not use Firestore as a second general database unless a future requirement clearly needs it. This avoids having multiple sources of truth.

---

## 3. Core Features to Keep

### Android Application

#### Home / SOS
- Large SOS button
- Get current GPS location
- Send SOS to backend
- Show current SOS status
- Allow user to mark themselves safe or end the SOS when appropriate

#### Map
- Show student's current location
- Use MapLibre
- Show relevant verified incidents if needed
- Do not build navigation or route planning

#### Incident Reporting
- Select incident type
- Add short description
- Attach photo if needed
- Automatically include location
- Submit report to backend

#### Alerts
- Receive official safety broadcasts
- Display recent alerts
- Receive FCM push notifications

#### Profile
- Basic account information
- Emergency contacts
- Logout

---

## 4. Admin Web Features

Keep the admin dashboard focused on four modules.

### SOS Cases
- View active SOS cases
- View student information
- View latest location on map
- Acknowledge SOS
- Mark SOS as resolved

### Incident Reports
- View submitted incidents
- View photo, description, and location
- Update report status

### Broadcasts
- Create safety announcement
- Send announcement to students
- Store announcement history

### Users
- View registered users
- View basic user information
- Enable/disable account only if required

---

## 5. Simplified Database

Target around **5 collections**.

### `users`

Stores the student profile and emergency contacts.

```text
users
├── _id
├── firebase_uid
├── name
├── email
├── role
├── emergency_contacts[]
│   ├── name
│   ├── relationship
│   └── phone
├── created_at
└── updated_at
```

Emergency contacts are embedded instead of having their own collection.

### `sos_cases`

```text
sos_cases
├── _id
├── user_id
├── status
├── location
│   ├── latitude
│   └── longitude
├── updates[]
│   ├── status
│   └── timestamp
├── created_at
├── acknowledged_at
└── resolved_at
```

Suggested statuses:

```text
active → acknowledged → resolved
```

A separate `sos_events` collection is not necessary for the simplified version.

### `incidents`

```text
incidents
├── _id
├── user_id
├── type
├── description
├── photo_url
├── location
├── status
├── created_at
└── updated_at
```

Suggested statuses:

```text
submitted → reviewed → resolved
```

### `broadcasts`

```text
broadcasts
├── _id
├── title
├── message
├── created_by
├── created_at
└── sent_at
```

### `notifications`

Use only if notification history is required.

```text
notifications
├── _id
├── user_id
├── type
├── title
├── message
├── read
└── created_at
```

If notification history is not required, this collection can be removed and Beacon can rely on broadcasts + FCM.

---

## 6. Simplified SOS Flow

This is the most important workflow in Beacon.

```text
Student presses SOS
        ↓
App gets GPS location
        ↓
POST /sos
        ↓
Backend verifies Firebase user
        ↓
Create SOS case in MongoDB
        ↓
Admin dashboard displays ACTIVE SOS
        ↓
Admin opens case and views location
        ↓
Admin acknowledges case
        ↓
Student receives status update / notification
        ↓
Admin resolves case
        ↓
SOS CLOSED
```

### Location During SOS

Avoid building a complicated continuous tracking system first.

If location updates are required:

```text
Active SOS
    ↓
Android periodically gets location
    ↓
PATCH /sos/:id/location
    ↓
MongoDB stores latest location
    ↓
Admin map refreshes latest location
```

Build real-time streaming only if it becomes a real requirement later.

---

## 7. Simplified API

### User

```http
GET /me
PUT /me
PUT /me/emergency-contacts
```

### SOS

```http
POST  /sos
GET   /sos/:id
PATCH /sos/:id/location
PATCH /sos/:id/status
```

### Incidents

```http
POST /incidents
GET  /incidents
GET  /incidents/:id
```

### Broadcasts

```http
GET /broadcasts
```

### Admin

```http
GET   /admin/sos
GET   /admin/sos/:id
PATCH /admin/sos/:id

GET   /admin/incidents
PATCH /admin/incidents/:id

POST  /admin/broadcasts

GET   /admin/users
```

Only add endpoints when the application actually needs them.

---

## 8. Features Removed or Postponed

These features are not part of the simplified core version.

### Remove for Now

- Friend connection/social system
- Complex device management
- Separate SOS events collection
- Separate emergency contacts collection
- Large audit logging system
- Multiple complicated admin roles
- Social/community features
- Navigation or route planning

### Postpone

- Advanced heatmaps
- Advanced analytics
- Real-time continuous location streaming
- Complex incident verification workflow
- Detailed notification management
- SMS integration
- Advanced emergency responder system

These can become **future enhancements** after the core system is stable.

---

## 9. Development Phases

### Phase 1 — Clean the Architecture

**Goal:** Remove unnecessary complexity before adding more features.

Tasks:
- Finalize the 4–5 collection MongoDB structure
- Remove unused collections/models
- Remove unused API routes
- Keep MongoDB as the main database
- Keep Firebase only for Auth and FCM
- Confirm Android, backend, and admin environment variables

**Done when:**

The project has one clear database structure and all three applications can connect correctly.

---

### Phase 2 — Authentication and User Profile

**Goal:** Make authentication reliable.

Tasks:
- Firebase email/password login
- Backend Firebase token verification
- Create/retrieve user profile from MongoDB
- Profile screen
- Emergency contacts
- Admin authentication

**Done when:**

A student can log in, access their profile, and the backend correctly identifies them.

---

### Phase 3 — Build the Complete SOS Flow

**Goal:** Finish Beacon's most important feature before anything else.

Tasks:
- Get Android GPS location
- SOS button
- `POST /sos`
- Store SOS in MongoDB
- Admin active SOS list
- Admin SOS details
- Show location on admin map
- Acknowledge SOS
- Resolve SOS
- Send status notification to student

**Done when:**

```text
Android → Backend → MongoDB → Admin → Status Update → Android
```

works from beginning to end without manually changing the database.

---

### Phase 4 — Incident Reporting

**Goal:** Add the second major student safety feature.

Tasks:
- Incident report form
- Location attachment
- Optional photo upload
- Store report in MongoDB
- Admin incident list
- Admin incident details
- Status update

**Done when:**

A student can submit an incident and the admin can review and update it.

---

### Phase 5 — Safety Broadcasts

**Goal:** Allow admins to communicate with students.

Tasks:
- Admin broadcast form
- Save broadcast
- Send FCM notification
- Android Alerts screen
- Display recent broadcasts

**Done when:**

An admin can create an alert and the student receives and sees it in Beacon.

---

### Phase 6 — Maps and UI Cleanup

**Goal:** Improve usability without adding major features.

Tasks:
- Clean Android Map screen
- Improve loading/error states
- Improve SOS status display
- Improve admin dashboard layout
- Mobile responsiveness for admin web
- Empty states
- Confirmation dialogs

Do not add new major features during this phase.

---

### Phase 7 — Testing and Deployment

**Goal:** Make the existing system reliable.

Test:
- Login/logout
- Invalid/expired authentication
- GPS unavailable
- Internet unavailable
- SOS creation
- Duplicate SOS attempts
- SOS acknowledgement
- SOS resolution
- Incident submission
- Photo upload failure
- Broadcast sending
- Push notifications
- Backend/database connection failure

Deployment target:

```text
Android APK
      ↓
Express Backend → Cloud Hosting
      ↓
MongoDB Atlas

React Admin → Vercel

Firebase → Authentication + FCM
```

**Done when:**

The system can be demonstrated using deployed services instead of depending on a developer's local computer.

---

## 10. Development Priority

Follow this order:

```text
1. Backend/database stability
        ↓
2. Authentication
        ↓
3. SOS end-to-end
        ↓
4. Incident reporting
        ↓
5. Broadcasts/notifications
        ↓
6. Maps/UI improvements
        ↓
7. Testing
        ↓
8. Deployment
        ↓
9. Documentation
```

Do **not** build optional features while the SOS flow is incomplete.

---

## 11. Scope Control Rule

Before adding a feature, ask:

> Does this directly improve SOS, incident reporting, safety alerts, or administration?

If **yes**, consider it.

If **no**, move it to Future Enhancements.

Also avoid adding a new technology when an existing technology can already solve the problem.

---

## 12. Definition of MVP Complete

Beacon's simplified MVP is complete when:

- Student can register/login
- Student profile works
- Emergency contacts can be saved
- Student can send SOS with GPS location
- Admin can see the SOS and location
- Admin can acknowledge and resolve the SOS
- Student receives the SOS status update
- Student can submit an incident
- Admin can review incident reports
- Admin can send safety broadcasts
- Student receives/views safety broadcasts
- Backend and database are deployed and accessible online
- Main workflows have proper error handling

Anything beyond this list is **not required for the MVP**.

---

## 13. Future Enhancements

Only consider these after the MVP is stable:

- Live location streaming
- SMS emergency alerts
- Friend/family connections
- Advanced heatmaps
- Incident analytics
- Multiple admin permission levels
- Detailed audit logs
- Emergency responder assignment
- Advanced notification center
- Route/navigation features

---

## 14. Final Simplified Scope

### Student

```text
Login
  ↓
Home / SOS
  ├── Send SOS
  ├── Report Incident
  └── See current status

Map
  └── View location / relevant incidents

Alerts
  └── Receive official safety announcements

Profile
  └── Account + Emergency Contacts
```

### Admin

```text
Dashboard
  ├── SOS Cases
  ├── Incident Reports
  ├── Broadcasts
  └── Users
```

### System

```text
Android: Kotlin + XML
Admin: React
Backend: Node.js + Express
Database: MongoDB
Authentication: Firebase Auth
Notifications: Firebase FCM
Maps: MapLibre
```

---

## Final Principle

> **Make Beacon reliable before making Beacon bigger.**

A smaller system where the complete emergency workflow works correctly is better than a large system with many unfinished or unreliable features.

The main success path should always remain:

```text
SOS → Location → Backend → Database → Admin → Response → Student
```
