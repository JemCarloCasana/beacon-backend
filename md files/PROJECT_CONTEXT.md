# PROJECT CONTEXT

---

## 1. Project Identity

**Project Name:** Beacon

**Type of System:** Mobile-first public safety and emergency response platform

**General Category:** Community safety, emergency alerting, and incident reporting system

**Main Purpose:** To allow individuals — particularly citizens and students — to quickly signal emergencies, report incidents, and alert their trusted contacts, while providing administrators and responders a real-time dashboard to monitor and coordinate emergency responses.

**Intended Environment:** The system is designed for use in community or urban settings where rapid communication during emergencies is essential. Based on the codebase, the system is specifically oriented toward a Philippine context (phone number formats use Philippine standards, the timezone defaults to `Asia/Manila`, and emergency categories align with local responder units).

**Simple Explanation:**

> Beacon is a mobile safety platform that lets users send SOS distress signals, report community incidents, and alert their friends in an emergency — while a team of administrators monitors all alerts in real-time and coordinates appropriate emergency unit responses.

---

## 2. Project Purpose

Beacon exists to solve the problem of slow, fragmented, or inaccessible emergency communication for everyday people. It provides a fast, structured, and connected way for individuals to:

- Send an SOS alert with a single action, automatically notifying both their trusted friends and administrators.
- File detailed incident reports — such as fires, accidents, or crimes — with supporting evidence including photos.
- Know whether their emergency has been received, acknowledged, and responded to.
- Stay connected with a trusted circle of friends who can be alerted during a crisis.

On the administrative side, Beacon gives responders and administrators a structured, real-time view of all active emergencies so they can coordinate the right response unit (medical, fire, police, or traffic enforcement) and communicate updates back to the person in distress.

---

## 3. Problem Being Addressed

In emergency situations, time is critical — and existing communication channels such as phone calls, text messages, or manual reporting systems are often slow, disorganized, or unavailable.

**The core problems Beacon addresses are:**

- **Delayed emergency reporting:** People in distress often cannot effectively communicate their situation quickly to the right parties.
- **Disconnected support networks:** Friends and family nearby often have no way of knowing that someone they care about is in danger.
- **Lack of structured incident reporting:** Community incidents (accidents, fires, violent events) frequently go unreported or are difficult to track and follow up on.
- **No real-time visibility for administrators:** Emergency coordinators have no centralized way to see all ongoing emergencies, their status, and what response is being taken.
- **No feedback loop:** After reporting an emergency, users have no way of knowing whether their alert was received or acted upon.

Beacon solves these problems by creating a connected system where users, friends, and administrators are all linked — making emergency response faster, more coordinated, and more transparent.

---

## 4. Target Users

### Citizens

Ordinary community members who need to be able to quickly and easily signal emergencies and report incidents in their area. They expect the system to act quickly on their behalf and keep them informed of what is happening with their report.

### Students

A specific sub-group of community users. Students use the system in the same manner as citizens — to send SOS alerts, report incidents, and maintain a safety network of friends.

### Administrators

Staff or personnel responsible for monitoring the system's dashboard, reviewing incoming SOS alerts and incident reports, coordinating appropriate response units, and managing the overall emergency response workflow.

### Personnel (Responders / Staff)

Individuals with limited administrative access who are part of the response team. They can be assigned to handle emergencies, with the possibility of being elevated to a full administrator role through an internal approval process.

---

## 5. User Roles

### App User (Citizen / Student)

**Purpose:**
To give everyday individuals the ability to reach out for help, report incidents, and maintain a safety network.

**Responsibilities:**
- Keeping their profile and emergency contact information up to date.
- Sending SOS alerts when they are in danger.
- Reporting incidents they witness or experience.
- Building a network of trusted friends within the app.

**Main Activities:**
- Sending SOS alerts with location and emergency category.
- Submitting incident reports with descriptions and photos.
- Managing a personal list of emergency contacts.
- Adding and managing friends on the platform.
- Viewing notifications about the status of their SOS alerts and incident reports.
- Receiving broadcast messages from administrators.

---

### Administrator (Admin)

**Purpose:**
To oversee all incoming emergencies and incidents, coordinate responses, and ensure that alerts are handled appropriately and in a timely manner.

**Responsibilities:**
- Monitoring all live and historical SOS alerts and incident reports.
- Acknowledging incoming SOS alerts and assigning the appropriate emergency unit.
- Updating the status of incidents as they progress through response phases.
- Managing app users and admin/personnel accounts.
- Sending broadcast alerts to users.
- Reviewing safety reports and analytics.

**Main Activities:**
- Viewing the live SOS map and active alert list.
- Acknowledging and resolving SOS alerts.
- Managing incident report statuses (pending → dispatched → in progress → resolved).
- Managing user accounts and personnel accounts.
- Generating and exporting safety reports.
- Sending system-wide or role-targeted broadcast messages.

---

### Personnel

**Purpose:**
A staff member who has limited administrative capabilities and can be escalated to a full administrator through an internal request process.

**Responsibilities:**
- Handling emergencies within their designated scope.
- Receiving admin access requests from administrators.
- Accepting or declining the escalation of their access to full admin.

**Main Activities:**
- Responding to incidents or SOS alerts within their role.
- Managing their own account information.
- Receiving notifications related to admin access requests.

---

## 6. Main Features

### SOS Alerting

**Purpose:**
To allow a user in immediate danger to quickly trigger an emergency alert.

**Who uses it:**
App users (citizens and students).

**What users can do:**
- Send an SOS alert specifying the type of emergency: Medical, Fire, Violence, or Unknown.
- Include their current location (GPS coordinates and address) and an optional message.
- Automatically notify all their Beacon friends via push notification.
- Receive notification updates when their SOS is acknowledged or resolved by administrators.
- Mark their own SOS as cancelled or safe once the danger has passed.

**Why it matters:**
This is the core life-safety feature of the platform. A single action instantly alerts both a trusted personal network and the administrative team, significantly reducing response time.

---

### Incident Reporting

**Purpose:**
To allow users to formally report incidents they encounter in their community.

**Who uses it:**
App users (citizens and students). Administrators manage and respond to reports.

**What users can do:**
- Submit a detailed incident report with a type, description, and optional location.
- Attach up to 5 photo images as evidence.
- Receive notifications as the status of their report changes (dispatched, in progress, resolved).

**Why it matters:**
Incident reports create a structured, trackable record of community safety events that administrators can prioritize, assign to the right department, and resolve with documented outcomes.

---

### Friend Network

**Purpose:**
To create a trusted circle of contacts within the app who are automatically alerted when a user sends an SOS.

**Who uses it:**
App users.

**What users can do:**
- Search for other users by name.
- Send friend requests using a unique Beacon Code.
- Accept or decline incoming friend requests.
- View and search their current friend list.
- Remove friends.

**Why it matters:**
The friend network is the personal safety layer of Beacon. When an SOS is triggered, all friends receive an immediate push notification — creating a rapid personal response network in addition to the official administrative channel.

---

### Emergency Contacts

**Purpose:**
To allow users to store the phone numbers of trusted people they would want contacted in an emergency.

**Who uses it:**
App users.

**What users can do:**
- Add emergency contacts with a name, phone number, and relationship label.
- Designate up to 3 primary contacts.
- Edit or remove existing contacts.

**Why it matters:**
Emergency contacts provide an offline safety reference — a list of people who should be called if needed, accessible within the app at any time.

---

### Admin SOS Management (Live Dashboard)

**Purpose:**
To give administrators real-time visibility and control over all active SOS emergencies.

**Who uses it:**
Administrators.

**What administrators can do:**
- View a live map of all active SOS events with location information.
- Browse a live list of all SOS threads, filterable by status (active, resolved, cancelled, safe).
- Acknowledge an SOS alert, assign it to a response unit (Emergency Medical, Fire Station, Police Personnel, or Traffic Enforcement), and leave a note.
- Resolve an SOS, recording the outcome.
- View the full event history of any SOS thread.

**Why it matters:**
This feature is the operational heart of the administrative side. It gives responders the situational awareness needed to coordinate an effective emergency response and ensures no alert goes unnoticed.

---

### Incident Management (Admin)

**Purpose:**
To allow administrators to review, prioritize, and manage all incident reports submitted by users.

**Who uses it:**
Administrators.

**What administrators can do:**
- View a list of all incident reports with filters by status.
- Open an individual incident report to view its full details and images.
- Update the incident's status through the lifecycle: Pending → Dispatched → In Progress → Resolved.
- Assign the incident to a department (Medical, Fire, Police, or Traffic Enforcement).
- Set or update the priority level (Critical, High, Medium, Low).
- Add resolution notes when closing an incident.

**Why it matters:**
Incident management ensures that reported events are not just recorded but are actively tracked, assigned to the right responders, and resolved with accountability.

---

### Broadcast Messaging

**Purpose:**
To allow administrators to send important announcements or warnings to all users or a specific group.

**Who uses it:**
Administrators create and send broadcasts. App users receive them.

**What administrators can do:**
- Create a broadcast message with a title, body, and severity level (Announcement, Warning, or Danger).
- Target the message to all users or to a specific role (citizens or students).
- Send the broadcast, which triggers push notifications to all matching users.

**What users can do:**
- View received broadcasts in their notification inbox.
- Acknowledge a broadcast to mark it as read.

**Why it matters:**
Broadcasts enable administrators to proactively communicate community-wide safety information — such as weather warnings, curfews, or area alerts — to all or specific segments of users.

---

### Safety Reports and Analytics (Admin)

**Purpose:**
To give administrators data-driven insights into emergency and incident trends over time.

**Who uses it:**
Administrators.

**What administrators can do:**
- View a dashboard overview of key safety metrics for the last 24 hours, 7 days, or 30 days.
- See counts of total incidents, active incidents, resolved incidents, and active SOS events.
- View charts showing incidents by status, by priority, by category, and trends over time.
- See average response time and resolution time data.
- Generate named reports (Daily, Weekly, Monthly Safety Reports).
- Export raw data as a CSV file for offline analysis.

**Why it matters:**
Analytics help administrators understand patterns in community safety — identifying peak times, common emergency types, and response performance — enabling more informed decision-making and resource planning.

---

### Personnel and Admin Management

**Purpose:**
To allow higher-level administrators to manage who has access to the administrative system and at what level.

**Who uses it:**
Administrators with management permissions.

**What administrators can do:**
- Create new administrator and personnel accounts.
- View a list of all admin/personnel accounts.
- Update account details (name, email).
- Activate or deactivate personnel accounts.
- Submit admin access upgrade requests for personnel.
- Accept or decline admin access requests (elevating a personnel member to full admin).

**Why it matters:**
This feature controls who can access sensitive emergency data and administrative functions, ensuring that the system is managed by the right people with the right level of access.

---

### User Profile Management

**Purpose:**
To allow users to create and maintain their in-app identity.

**Who uses it:**
App users.

**What users can do:**
- Register their profile with their full name, phone number, and role (citizen or student).
- Update their name, email, phone number, and profile image.
- View their unique Beacon Code — a short identifier others can use to find and add them as friends.

**Why it matters:**
A complete and accurate profile allows the system to identify users correctly in emergencies and enables friends to find each other within the app.

---

### Push Notifications

**Purpose:**
To keep users and administrators informed in real time about events that affect them.

**Who uses it:**
Both app users and administrators.

**Events that trigger notifications for users:**
- An SOS they sent has been acknowledged by an admin (with which unit was assigned).
- An SOS they sent has been resolved.
- A friend they are connected to has sent an SOS.
- A friend's SOS has been resolved or closed.
- An incident report they submitted has changed status (dispatched, in progress, resolved).
- A broadcast message has been sent to them.

**Events that trigger notifications for administrators:**
- A new SOS alert has been created.
- A new incident report has been submitted.
- An admin access request has been sent to them.

**Why it matters:**
Push notifications are the real-time communication backbone of Beacon, ensuring that nobody misses a critical update regardless of whether they are actively using the app.

---

## 7. User Activities

App users can perform the following actions within the system:

- **Create an account** by registering with a name, phone number, and role (citizen or student).
- **Log in** to access their profile and the platform's features.
- **Set up a profile** including name, email, phone number, and profile photo.
- **Send an SOS alert** specifying the emergency type and their location.
- **Update SOS status** by marking their own alert as cancelled or safe.
- **Submit an incident report** with a description, location, and up to 5 photos.
- **Add emergency contacts** (name and phone number) for quick reference.
- **Search for other users** by name to find and add them as friends.
- **Send a friend request** using a Beacon Code.
- **Accept or decline** incoming friend requests.
- **View their friend list** and search within it.
- **Remove a friend** from their network.
- **Register their device** to receive push notifications.
- **View their notifications** including SOS updates, incident updates, and broadcasts.
- **Mark notifications as read.**
- **View received broadcasts** from administrators.
- **Acknowledge a broadcast** message.

---

## 8. Main User Workflows

### Account Registration

A new user downloads the Beacon mobile app and signs in using Firebase Authentication (Google account or similar). Upon first login, they complete their profile setup by providing their full name, phone number, and selecting their role (citizen or student). The system automatically generates a unique **Beacon Code** for them — a short identifier like `BCN-A3K8RM` — that others can use to find and friend them.

---

### Sending an SOS Alert

When a user is in danger, they open the app and trigger an SOS. They specify:
- The type of emergency: **Medical**, **Fire**, **Violence**, or **Unknown**
- Their location (automatically detected via GPS or manually entered as an address)
- An optional message describing the situation

Once submitted:
1. All of the user's Beacon friends receive an immediate push notification informing them that their friend needs help.
2. All active administrators receive a notification about the new SOS alert.
3. The SOS appears on the admin live dashboard for immediate action.

The user can later mark their SOS as **cancelled** (false alarm) or **safe** (situation resolved).

---

### Reporting an Incident

A user who witnesses or experiences a community event (accident, fire, crime, etc.) can file an incident report. They provide:
- The type of incident
- A written description (minimum 5 characters)
- Location details (coordinates or address)
- Up to 5 photos as supporting evidence

After submission, administrators are notified and can manage the report through its full lifecycle.

---

### Managing the Friend Network

Users can build their safety network by:
1. Searching for other users by name.
2. Sending a friend request using the recipient's Beacon Code.
3. The other user receives a pending request and can accept or decline.
4. Once accepted, both users appear in each other's friend list.

Friends are the primary recipients of SOS push notifications — making the friend network a critical part of the personal safety layer of Beacon.

---

### Receiving SOS Updates (as a sender)

After sending an SOS, the user continues to receive push notifications as the situation progresses:
- When an admin **acknowledges** the alert (including which unit was dispatched — e.g., "Police Personnel has been assigned").
- When the SOS is **resolved** by an admin.

This ensures the user knows their alert was received and acted upon.

---

### Administrator: Responding to an SOS

When a new SOS appears on the admin dashboard:
1. The administrator opens the live SOS list or map.
2. They review the details: who sent it, the category, location, and any message.
3. They **acknowledge** the SOS by assigning it to the appropriate unit (Emergency Medical, Fire Station, Police Personnel, or Traffic Enforcement) and optionally leaving a note.
4. The SOS sender immediately receives a push notification that their alert has been acknowledged and which unit has been assigned.
5. Once the situation is resolved, the admin **closes** the SOS, and the sender and their friends are notified.

---

### Administrator: Managing an Incident Report

1. The admin receives a notification about a new incident report.
2. They open the report to review the type, description, location, priority, and any attached photos.
3. They update the status as work progresses: **Pending → Dispatched → In Progress → Resolved**.
4. They can assign it to a department and add resolution notes.
5. At each milestone status change, the user who submitted the report receives a push notification about the update.

---

### Administrator: Sending a Broadcast

1. An administrator creates a broadcast message with a title, body content, and severity level (Announcement, Warning, or Danger).
2. They select the audience: **all users** or a specific role group (citizens or students).
3. They trigger the send, which delivers a push notification to all matching users.
4. Users can view the broadcast in their inbox and acknowledge it.

---

### Administrator: Generating a Safety Report

1. An administrator navigates to the reports section.
2. They view the overview analytics dashboard for the last 24 hours, 7 days, or 30 days.
3. They can generate a named report (Daily, Weekly, or Monthly Safety Report), which is recorded in the system.
4. They can export the report as a CSV file containing all KPIs, charts, and detailed incident and SOS data.

---

## 9. User Journey

### App User Journey

```
Download and open the app
        ↓
Sign in (via Firebase Authentication)
        ↓
Complete profile setup (name, phone, role → Citizen or Student)
        ↓
Receive unique Beacon Code
        ↓
Add emergency contacts
        ↓
Search for friends and build safety network (send/accept friend requests)
        ↓
Register device for push notifications
        ↓
--- NORMAL USE ---
        ↓
Experience an emergency OR witness an incident
        ↓
  [Emergency] Send SOS → Friends and admins are notified instantly
        ↓
  Receive push notification: "Your SOS has been acknowledged – Police dispatched"
        ↓
  Receive push notification: "Your SOS has been resolved"
        ↓
  [Incident] Submit incident report with description and photos
        ↓
  Receive push notifications as report status changes (Dispatched → In Progress → Resolved)
        ↓
View all past notifications and broadcast messages
```

---

### Administrator Journey

```
Log in to the admin dashboard
        ↓
View real-time SOS alerts on the live map and list
        ↓
Receive notification: "New SOS Alert – [User Name] needs help"
        ↓
Open SOS details: review location, category, message
        ↓
Acknowledge SOS → assign unit → SOS sender is notified
        ↓
Resolve SOS → sender and friends are notified
        ↓
Receive notification: "New Incident Report"
        ↓
Open incident report → review details and photos
        ↓
Update status → assign department → add notes → resolve
        ↓
Create and send broadcast messages to users as needed
        ↓
View analytics dashboard: incidents, SOS trends, response times
        ↓
Generate and export safety reports
        ↓
Manage user accounts and admin/personnel accounts as needed
```

---

## 10. System Information

### User Profiles

Represents a registered app user. Every user has a name, email, phone number, role (citizen or student), profile image, and a unique **Beacon Code**. The Beacon Code is their discoverable identity within the app — it is what other users search for to send friend requests.

### SOS Alerts (SOS Threads and Events)

Represents an active or historical emergency signal. Each SOS has a category (Medical, Fire, Violence, Unknown), location details, an optional message, and a status (Active, Acknowledged, Resolved, Cancelled, Safe). The system tracks the full event history of each SOS — from creation through acknowledgment to resolution — providing a complete audit trail.

### Incident Reports

Represents a reported community incident. Each report includes a type, description, location, priority level, assigned department, and status. Reports can include up to 5 photos as evidence. Status progresses through a defined lifecycle: Pending → Dispatched → In Progress → Resolved.

### Friendships and Friend Requests

Represents the trusted connections between users. A friendship is established through a request-and-accept process. Friendships are the primary mechanism for personal SOS notifications — friends are the first people alerted when a user sends an SOS.

### Emergency Contacts

Represents personal off-platform contacts (name and phone number) stored by a user for reference in emergencies. Up to 3 can be designated as "primary" contacts.

### Devices

Represents a registered mobile device associated with a user account. Device registration enables push notifications. Each device has a push notification token (FCM token) and a platform identifier.

### Broadcasts

Represents a system-wide or role-targeted message sent by an administrator. Broadcasts have a severity level (Announcement, Warning, Danger) and can be targeted to all users or specific role groups. Delivery and acknowledgment are tracked per user.

### Notifications (User)

Represents updates delivered to app users about their SOS alerts, incident reports, and broadcast messages. Each notification can be marked as read.

### Notifications (Admin)

Represents alerts delivered to administrators about new SOS events, new incident reports, and admin access requests. Admins can view and manage their notification inbox.

### Admin Accounts and Roles

Represents the administrative staff with access to the dashboard. Admin accounts have roles (Admin or Personnel) that determine what actions they can perform. Permissions are granular and role-based.

### Admin Access Requests

Represents a request to elevate a personnel account to full admin access. The request is submitted by an administrator and must be accepted by the personnel member (or an admin with sufficient permissions).

### Safety Reports

Represents generated analytical summaries of the system's activity. Reports include KPIs (total incidents, active SOS, average response times) and chart data (by status, priority, category, and time trend). Reports can be exported as CSV files.

---

## 11. Administrator Purpose

The administrative side of Beacon serves as the command-and-control layer of the platform. Administrators are responsible for ensuring that every emergency alert and incident report is seen, responded to, and resolved.

**Administrators monitor:**
- All incoming SOS alerts in real time via a live map and alert list.
- All submitted incident reports and their current status.
- System-level notifications about new emergencies and incidents.
- User activity and account status.
- Safety analytics and trends over time.

**Administrators manage:**
- SOS alerts: acknowledging them, assigning response units, and resolving them.
- Incident reports: updating statuses, assigning departments, setting priorities, and adding resolution notes.
- App user accounts: viewing profiles and updating account information.
- Admin and personnel accounts: creating accounts, managing access levels, and activating or deactivating accounts.
- Broadcast messages: creating, targeting, and sending system-wide announcements.
- Safety reports: generating and exporting analytics.

**Administrators review:**
- Incident photos submitted as evidence.
- The full event history of SOS threads.
- Admin access requests from personnel seeking elevation.

**Decisions administrators make:**
- Which emergency unit to assign to an SOS (Medical, Fire, Police, Traffic Enforcement).
- The priority level of an incident report (Critical, High, Medium, Low).
- Which department to assign an incident to.
- Whether to approve or decline an admin access request.
- Whether to activate or deactivate a user or personnel account.
- What broadcasts to send and who receives them.

---

## 12. System Scope

### Core Purpose

Beacon is primarily a **real-time community emergency alerting and response coordination system**. Its central function is to connect people in distress with both their personal support network and an administrative response team — quickly, reliably, and with full status visibility.

### Main Areas

1. **Emergency Alerting (SOS):** Instant distress signals with location, category, and personal notification.
2. **Incident Reporting:** Structured reporting of community incidents with evidence and status tracking.
3. **Personal Safety Network (Friends):** A trusted circle of contacts who receive emergency notifications.
4. **Emergency Contact Management:** Storage of off-platform emergency contacts for personal reference.
5. **Administrative Emergency Management:** Real-time monitoring, acknowledgment, and resolution of all alerts and reports.
6. **Broadcast Communication:** One-to-many messaging from administrators to app users.
7. **Analytics and Reporting:** Data-driven summaries of safety activity for administrative oversight.
8. **Account and Personnel Management:** Control over who uses the system and at what level.

### Users

The system is designed to serve two broad groups:

- **Community members** (citizens and students) who need emergency tools and a personal safety network.
- **Administrative staff** (admins and personnel) who monitor, respond to, and resolve emergency events.

### Use Cases

The system is designed to be used in situations such as:
- A person experiencing a medical emergency activating an SOS.
- A student witnessing a violent incident and reporting it with a photo.
- An administrator coordinating police response to a reported incident.
- A community coordinator sending a warning broadcast about an ongoing safety hazard.
- A safety officer reviewing weekly incident trends and exporting data for a report.

---

## 13. Real-World Use Cases

### Use Case 1: Medical Emergency

A student collapses on campus and a bystander uses Beacon to send an SOS with the category "Medical" and the building's location. All of the sender's Beacon friends receive an instant push alert. Simultaneously, the admin dashboard shows the new SOS. An administrator acknowledges it, assigns it to the Emergency Medical Unit, and the sender receives a notification confirming that medical help is on the way. Once the situation is handled, the admin resolves the SOS, and all involved parties are notified.

---

### Use Case 2: Fire Incident Report

A citizen notices a fire starting in an abandoned building and uses Beacon to submit an incident report. They include a description, the address, and several photos taken from their phone. An administrator receives a notification, opens the report, reviews the images, sets the priority to "High," assigns it to the Fire Station Unit, and updates the status to "Dispatched." The citizen who submitted the report receives a push notification that a fire unit has been dispatched. The status continues to update as the situation progresses.

---

### Use Case 3: Personal Safety Network Alert

A user is walking home late at night and feels unsafe. They trigger an SOS with the category "Unknown" and their current GPS location. Their three Beacon friends — all nearby — instantly receive a push notification saying "[User Name] needs help. Tap to view details." One of the friends who is close by is able to respond immediately. The user can then cancel the SOS once they are safe, which also notifies their friends.

---

### Use Case 4: Community-Wide Safety Broadcast

An administrator is made aware of a dangerous situation in a specific area. Using the broadcast feature, they compose a "Warning" level message: "Please avoid the downtown area due to an ongoing emergency situation." They send it to all users, who receive an immediate push notification. Users can open the app to read the full message and acknowledge it.

---

### Use Case 5: Weekly Safety Review

At the end of the week, a safety officer logs into the admin dashboard and navigates to the reports section. They generate a Weekly Safety Report to review the past 7 days of activity: total incidents reported, how many were resolved, average response times, which incident types were most common, and how many SOS events occurred. They export this as a CSV file to include in their weekly briefing.

---

### Use Case 6: Personnel Elevation Request

A new staff member joins the response team and is onboarded with a "Personnel" account. After demonstrating their capability, a senior administrator submits an admin access request for them. The personnel member receives a notification in their admin inbox and accepts the request, elevating their account to full "Admin" status with expanded system access.

---

## 14. Overall System Concept

**What is the system?**
Beacon is a mobile safety platform that connects individuals in distress with their personal friend network and an administrative response team.

**Why does it exist?**
It exists to reduce the time and friction involved in requesting and coordinating emergency help — making it faster and easier for people to get assistance when they need it most.

**Who uses it?**
Two groups: app users (citizens and students) who experience or witness emergencies, and administrative staff who monitor and coordinate responses.

**What do users use it for?**
App users use it to send SOS distress signals, report incidents, build a trusted friend network, store emergency contacts, and receive updates about their alerts. Administrators use it to monitor all emergencies in real time, dispatch response units, manage incident reports, send broadcasts, and review analytics.

**What are the major activities?**
Sending SOS alerts, reporting incidents, alerting friends, acknowledging and resolving emergencies, assigning response units, broadcasting safety messages, and generating safety reports.

**What information does it handle?**
User profiles, SOS alerts with location and status history, incident reports with photos, friend connections, emergency contacts, push notification tokens, broadcast messages, admin accounts, and safety analytics.

**How do users interact with it?**
App users interact through a mobile application. Administrators interact through a web-based admin dashboard. All interactions trigger real-time push notifications to relevant parties.

**What role do administrators have?**
Administrators are the responders and coordinators of the system. They ensure that no emergency goes unaddressed — reviewing, acknowledging, assigning, and resolving all SOS alerts and incident reports while keeping users informed throughout.

**What is the overall purpose of the system?**
To create a fast, connected, and transparent emergency communication and response system that empowers community members to get help quickly and gives administrators the tools to respond effectively.

---

## 15. Comprehensive Project Summary

**Beacon** is a mobile-first community safety and emergency response platform designed to help people signal distress, report incidents, and alert their trusted contacts during emergencies — while providing administrators with a real-time dashboard to monitor, coordinate, and resolve those emergencies efficiently.

The platform addresses a fundamental problem in emergency situations: the gap between the moment someone needs help and the moment effective help arrives. Existing channels are often slow, disconnected, or require too much effort from someone in a stressful situation. Beacon bridges this gap by making emergency communication fast, structured, and connected across three layers: the person in danger, their trusted social network, and a professional administrative response team.

---

### Who It Serves

Beacon serves two primary groups:

**App users** — citizens and students who are community members needing access to emergency tools. They can build a safety network of trusted friends, store emergency contacts, send instant SOS distress signals, and submit detailed incident reports with photos.

**Administrative staff** — administrators and personnel who monitor the system, coordinate responses, and ensure all emergencies are handled. They operate through an administrative dashboard with tools for live monitoring, incident management, broadcasting, and analytics.

---

### The SOS System

The most critical feature of Beacon is the SOS alert. When a user is in danger, they send an SOS from the mobile app specifying the type of emergency (Medical, Fire, Violence, or Unknown) along with their location and an optional message.

Upon submission:
- All of the user's Beacon friends receive an immediate push notification informing them that their friend needs help.
- All active administrators are notified and the SOS appears on their live dashboard.

Administrators can acknowledge the SOS and assign the appropriate emergency unit (Emergency Medical, Fire Station, Police Personnel, or Traffic Enforcement). The user receives real-time push notification updates — knowing when their alert was received, who was dispatched, and when the situation was resolved.

---

### The Friend Network

Users build a personal safety network by connecting with other Beacon users as friends. This is done by searching for users by name or by sharing a unique **Beacon Code** — a short identifier assigned to every user (e.g., `BCN-A3K8RM`). Friend requests are sent, reviewed, and accepted or declined. Once friends, both users appear in each other's safety network and will be automatically alerted whenever the other sends an SOS.

---

### Incident Reporting

Beyond immediate SOS alerts, users can file structured incident reports for events they witness or experience. Reports include the type of incident, a written description, location details, and up to 5 photos as supporting evidence. Administrators receive notifications about new reports and manage them through a formal status lifecycle: Pending → Dispatched → In Progress → Resolved. Users receive push notifications at each milestone, keeping them informed about what action is being taken.

---

### Administrative Command Center

The administrative side of Beacon provides a full suite of tools for managing community safety:

- **Live SOS Map and List:** Real-time view of all active SOS alerts with location, category, and status. Administrators can acknowledge alerts, assign response units, add notes, and resolve them.
- **Incident Management:** Full list of all incident reports with filtering, detail views including photos, status management, department assignment, and resolution notes.
- **Broadcast Messaging:** Create and send system-wide or role-targeted announcements with severity levels (Announcement, Warning, Danger) delivered via push notifications.
- **Safety Analytics:** Dashboard with KPIs and charts for 24-hour, 7-day, and 30-day windows including total incidents, SOS counts, response times, incident categories, and time trends. Includes the ability to generate named reports and export data as CSV files.
- **Account Management:** Tools to create, view, update, and manage both app user accounts and administrative/personnel accounts. Includes an internal admin access upgrade workflow for promoting personnel to full admin.

---

### Notifications Throughout

Push notifications are the communication backbone of Beacon. The system sends real-time alerts to ensure that no one misses a critical update:
- Users are notified when their SOS is acknowledged, when a unit is assigned, when their SOS is resolved, when a friend sends an SOS, and when their incident report changes status.
- Administrators are notified when new SOS alerts arrive, when new incident reports are submitted, and when admin access requests are received.

---

### Real-World Context

The system is specifically oriented toward a Philippine community context, with phone number formats following Philippine standards, timezone defaulting to Philippine Standard Time (Asia/Manila), and emergency categories aligned with local response units (Emergency Medical, Fire Station, Police Personnel, Traffic Enforcement).

---

### In Summary

Beacon is a comprehensive community safety platform that makes emergency help faster, more connected, and more transparent. It empowers ordinary people to reach out for help instantly, alerts their personal support network automatically, keeps them informed throughout the response, and gives administrative teams the real-time tools they need to coordinate an effective response — all within a single, integrated system.
