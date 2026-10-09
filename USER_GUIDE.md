# User Guide

A guide to the platform for every role. It covers signing in, the features each role can use,
and step-by-step walkthroughs of the main workflows.

- **User** — a member of a client organization.
- **Org Admin** — manages their organization's tickets, users, and services.
- **Administrator** — the platform (provider) operator; manages every organization, Slack bots,
  broadcasts, and platform settings.

Each role can do everything the role above it in this list can, plus more.

---

## 1. Getting started (everyone)

### Signing in
1. Go to the app and enter your **email** and **password**.
2. A **6-digit verification code** is emailed to you (multi-factor authentication is required on
   every login). Enter it to finish signing in.
3. Optional: tick **"Remember this device for 7 days"** on the code screen. On that browser you
   won't be asked for a code again for 7 days (you'll still enter your password). Changing your
   password clears trusted devices everywhere.

> **Didn't get the code?** Use **Resend code** (there's a short cooldown). Check spam. Codes
> expire after ~10 minutes; too many wrong tries cancels the attempt and you start over.

### Forgot / change password
- **Forgot password** (login screen) → you get a secure reset link by email.
- **Change password** any time from **My Profile**. Changing it signs you out of all other
  sessions and devices.

### My Profile
From the sidebar, **My Profile** lets you update your display name, change your password, and
manage MFA settings.

### The sidebar
Your role decides what appears:

| Nav item | User | Org Admin | Administrator |
|---|:--:|:--:|:--:|
| Dashboard | ✅ | ✅ | ✅ |
| Ticketing | ✅ | ✅ | ✅ |
| Assistant | ✅ | ✅ | ✅ |
| Credentials | ✅ | ✅ | ✅ |
| Services · Users | | ✅ | ✅ |
| Control Plane · Customer Services · Service Catalog · Slack Bots | | | ✅ |

---

## 2. Features everyone can use

### Assistant (chatbot)
**Sidebar → Assistant.** Ask questions in natural language and get streamed answers. Past
conversations are saved so you can reopen them from the history list.

### Notifications
A **bell** in the sidebar shows real-time updates (and pop-up toasts) relevant to you — updates
on your tickets, new escalations for administrators, etc. Click an item to jump to it.

### Announcements
Platform notices (maintenance windows, incidents) appear as **banners on your dashboard**. Dismiss
one with the ✕; it won't affect others.

### Secure Credentials
**Sidebar → Credentials.** When an AD bot issues a temporary password for your account (or for a
request you raised), it appears here. Click **Reveal** to see it **once** — copy it immediately,
because it's erased right after viewing and can't be shown again. Unviewed passwords expire after
24 hours. (Full walkthrough in §6.)

### Cookies, Privacy & Terms
On first visit you can **Accept / Reject / Cancel** non-essential cookies. Privacy Policy and Terms
are linked from the login screen and footer.

---

## 3. User

As a member of your organization you can raise and follow support tickets.

### Raise a ticket
**Ticketing → New Ticket.** Enter a **Title**, **Description**, pick a **Project**, **Type**
(bug/feature/task/story) and **Priority**. Submit — you'll get a ticket number (e.g. `TKT-001`).

### Track your tickets
Open any ticket to:
- read the description and current **status / priority / SLA**,
- add **comments** and **attachments**,
- **Watch** it to get notified of changes,
- see the full **activity trail**.

Your notification bell alerts you when someone updates a ticket you raised (status change, new
comment, (re)assignment).

---

## 4. Org Admin

Everything a User can do, plus full management of your organization's ticketing, people, and
services.

### Manage the ticketing desk
**Ticketing** gives you tabs for **Overview** (stats + charts), **Tickets**, **Projects**,
**SLAs**, **Reports**, and **New Ticket**.
- Change a ticket's **status, priority, assignee, and project**; view as a **table or board**.
- **Projects** — group tickets; optional round-robin auto-assignment.
- **SLAs** — define response/resolution targets per priority; tickets show live SLA timers.
- **Reports** — breakdowns by status/priority/type/project/assignee, exportable to CSV.

### Escalate a ticket to the platform administrators
When an issue needs the provider's team:
1. Open the ticket (must be **not closed** and not already escalated).
2. In the side panel set **Assignee → "Administrator"** (that's the only option — it escalates to
   the administrator group, not a named person).
3. Click **Escalate**. The ticket is copied to the administrators, grouped under your organization,
   and the administrators are notified. Escalation is an Org Admin action only.

### Raise a ticket for a Slack bot
If your organization has assigned bots, you can route a ticket to one:
1. **Ticketing → New Ticket**, fill the standard fields.
2. Under **Assign to**, switch from **Person** to **Bot** and pick a bot.
3. The bot's **custom form fields** appear (each bot has its own, defined by the administrator) —
   fill them in and submit.
4. The ticket is assigned to the bot and, if the bot has a Slack channel configured, the request +
   your form details are posted straight into that channel. You'll see "sent to the bot's Slack
   channel" on success.

### Manage users
**Sidebar → Users.** Invite and manage people in your organization (as **User** or **Org Admin**).

### Services
**Sidebar → Services.** View your organization's active services and their status/expiry.

---

## 5. Administrator

The platform operator. Everything an Org Admin can do, across **every** organization, plus the
platform control surfaces.

### Platform dashboard
**Dashboard** is organized into five numbered sections:
1. **Overview** — KPIs (client orgs, SLA breaches, revenue, open tickets).
2. **Operations** — the **SLA Breach Monitor** and **Escalated Tickets** (grouped per organization;
   click through to the platform ticketing store).
3. **Accounts & Services** — **At-Risk Accounts** and the **Service Expiry Watchtower** (renew in a click).
4. **Engagement** — Assistant adoption analytics.
5. **Communication & Governance** — **Announcements** composer and the **Audit Log**.

### Control Plane & services
- **Control Plane** (`/saas-admin`) — platform overview and all client organizations.
- **Customer Services** — assign/renew services per organization.
- **Service Catalog** — the master list of services you offer.

### Platform ticketing (escalations)
Your **Ticketing** view is the administrators' isolated store. The **Escalated** category shows
tickets forwarded by org admins, grouped per organization, with dual **Response/Resolution SLA**
bars and a rich detail modal (client info, resolved methods, reason for delay). You get bell/toast
alerts when new escalations arrive.

### Broadcast announcements
**Dashboard → Platform Announcements.** Compose a broadcast, choose **severity** (Info / Warning /
Critical), target **all organizations or a specific one**, optionally set an **expiry**, and
publish. It appears as a banner on the relevant dashboards. You can deactivate or delete any
announcement.

### Ticket number format (per-org codes)
You control how ticket numbers look platform-wide. Turn on **include org code** to get
`TKT-<ORGCODE>-001` per organization (e.g. **BankVault UK → `TKT-BVUK-001`**), each organization
counting independently. Codes are auto-derived from the org name and can be edited per organization.

### Users, impersonation & audit
- **Users** — manage platform users and other administrators; **reset passwords**; **impersonate** a
  user to see what they see (audited).
- **Audit Log** (on the dashboard) — search the platform trail and export filtered results.

### Slack bots (and AD credential delivery)
**Sidebar → Slack Bots** (`/saas-admin/bots`) is where you register and run bots. See §6 and §7.

---

## 6. Slack bots — setup & the ticket form builder (Administrator)

Each bot is a distinct capability with its own connection, ticket form, and organization access.

### Add & connect a bot
1. **Slack Bots → Add Bot.** Give it a name and paste its Slack **Bot token** (`xoxb-…`).
2. Optionally add an **App-level token** (`xapp-…`) to enable the **chat bridge** — Slack users can
   then message the bot and get answers from the Assistant, posted back to Slack.
3. Optionally add an **Incoming Webhook URL** — tickets assigned to this bot are posted into that
   Slack channel with all the form details.
4. The card shows a **live status dot**: green = connected, red = error (bad token), grey =
   disconnected. Use the toggle to connect/disconnect.

### Build the bot's ticket form
Open a bot → **Ticket Form** tab. On the left, add fields (label, key, type —
text / textarea / number / select / checkbox / **user email**, required, placeholder, help text) and
reorder them with ▲▼. The right pane is a **live preview** of exactly what an org admin will see.

### Choose who can use it
Open a bot → **Organizations** tab. Toggle on the organizations allowed to assign this bot as a
ticket assignee. An organization only sees bots you've enabled for it.

---

## 7. Workflow: AD temporary-password delivery (secure)

When an AD bot resets an account, the temporary password reaches the right person securely, in-app —
never in Slack chat.

**Administrator (one-time setup):**
1. On the bot's **Ticket Form**, add a **User email** field (this marks who the password is for).
2. On the bot's **Settings**, click **Generate API key** — copy the `adk_…` key **once** and paste
   it into your AD automation.

**Org Admin (files the request):**
3. Raise a **Bot** ticket for that bot and enter the target user's email in the **User email** field.

**AD automation (delivers):**
4. After resetting the account, it POSTs the temporary password to the platform (authenticated by
   the bot API key). The password is **encrypted at rest** immediately.

**Target user / requesting Org Admin (reveal):**
5. Go to **Credentials**. The delivery is listed with a **Reveal** button.
6. Click **Reveal → Reveal password**, then **Copy**. It can be shown **once per person** and is
   **erased** after viewing (and auto-expires after 24 hours if never viewed). Only the target user
   and the org admin who requested it can see it — nobody else, not even administrators.

---

## 8. Workflow quick-reference

| I want to… | Where | Notes |
|---|---|---|
| Raise a support ticket | Ticketing → New Ticket | Any role |
| Comment / attach a file | open the ticket | Any role |
| Escalate to the provider | ticket panel → Assignee "Administrator" → Escalate | Org Admin, unclosed tickets |
| Route a ticket to a Slack bot | New Ticket → Assign to **Bot** | Org Admin; org must have the bot |
| Reveal a temp AD password | Credentials → Reveal | Target user or requesting Org Admin, once |
| Broadcast a notice | Dashboard → Platform Announcements | Administrator |
| Register / connect a Slack bot | Slack Bots | Administrator |
| Turn on per-org ticket codes | ticket-number format setting | Administrator |
| Impersonate a user | Users | Administrator (audited) |

---

## 9. Troubleshooting (for users)

| Problem | What to do |
|---|---|
| No MFA code arrived | Wait a few seconds, use **Resend code**, check spam. Codes last ~10 min. |
| "Remember device" isn't skipping MFA | It's per-browser and cleared by a password change; on a new/incognito browser you'll be asked again. |
| Can't reveal a password a second time | By design — it's shown once per person then erased. Ask for it to be re-issued. |
| A password says "Expired" | Unviewed credentials expire after 24 h; the AD bot must re-deliver. |
| Locked out after logging in elsewhere | Only one active session is allowed; a new login can take over an idle one after ~30 min. |
| Escalate button missing | Only Org Admins can escalate, and only on **unclosed, not-yet-escalated** tickets. |
| A Slack bot isn't in my Bot list | The administrator hasn't assigned that bot to your organization. |

For anything else, use the **Assistant** or contact your administrator.
