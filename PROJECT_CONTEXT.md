# Uni Consultations — Project Context

This is a DEMO app. Keep everything simple and functional.
No fancy UI, no complex error handling beyond basics.
Goal is a working proof of concept, not production code.

## Stack

- Frontend: React 18 + Vite → S3 + CloudFront (OAC)
- Backend: AWS CDK (JavaScript) → Lambda (Node.js 22.x), API Gateway (REST), DynamoDB, Bedrock, Cognito, EventBridge
- Auth: AWS Amplify on the SPA, Cognito User Pools authorizer on the API
- Region: eu-west-1
- All Lambdas use AWS SDK v3 and CommonJS

## Features

- Students browse the faculty directory and reserve consultations either:
  - manually from the Professors page (REST `POST /bookings`), or
  - by chatting with the AI assistant (Bedrock + tool use).
- Both booking paths share a single core (`bookSlotCore`) so the same
  invariants apply (past-slot, self-booking, duplicate booking, capacity).
  Topic is mandatory in both paths.
- The Professors page shows the next 14 days of slots and surfaces the
  topics being discussed in any active group session on each professor
  card so students can spot relevant conversations before clicking through.
- Slots have `maxParticipants`. A slot with `maxParticipants > 1` is a
  group session. The professor's stated cap is the hard ceiling — joining
  via topic match never auto-expands it; only the manual capacity widget
  does.
- The chat assistant can semantically match a student's topic to existing
  group sessions with the same professor and offer to join one instead of
  booking a fresh slot. Matching is enrichment inside `get_professor_slots`
  (returned as `joinableMatches`) so the model only mentions grouping when
  there's an actual hit; joins go through `join_group_session`.
- Professors publish office-hour blocks (with configurable slot length and
  per-slot capacity), which the backend expands into individual slot rows.
  They can:
  - delete unbooked free blocks one-at-a-time (✕ on the row), or
  - "Cancel day" to wipe an entire day in one click (cancels every booking
    on that day with student notifications, then deletes the freed slots).
  - mark days as unavailable, and keep a private class schedule.
- Professors and admins see analytics dashboards.
- Professors get their own bottom-right chatbot widget for read-only
  questions about their schedule (separate tools + system prompt from the
  student chat).
- Daily report Lambda runs nightly and generates a per-professor summary
  for the next day's bookings. Reports are persisted (TTL 14 days) and
  surfaced on the professor home page.
- In-app notification bell polls a dedicated `/me/notifications` endpoint
  every 60s; read state is server-side, not a localStorage hash.
- Cancellation notifications are symmetric: a professor cancelling notifies
  the booked student (with optional reason); a student cancelling notifies
  the professor. For group sessions where other students remain, the
  professor sees a "dropped from your group session" line carrying the
  updated participant count instead of a generic cancel.

## DynamoDB — Single table: `ConsultationsApp`

PAY_PER_REQUEST. Two GSIs (`GSI1`, `GSI2`), both `ProjectionType.ALL`.
TTL attribute: `ttl`.

### Item shapes (current)

User profile (created by post-confirmation trigger):
```
PK: USER#{cognitoSub}        SK: PROFILE
GSI1PK: ROLE#{professor|student|admin}    GSI1SK: USER#{cognitoSub}
fields: userId, email, displayName, role, department?, subjects?, createdAt
```

Professor unavailable day:
```
PK: PROFESSOR#{professorId}  SK: UNAVAILABLE#{YYYY-MM-DD}
fields: professorId, date, reason, createdAt
```

Professor private class entry (owner-only, students never see):
```
PK: PROFESSOR#{professorId}  SK: CLASS#{classId}
fields: classId, subject, date, startTime, endTime, room, createdAt
```

Slot (one item per `slotDurationMinutes` window):
```
PK: PROFESSOR#{professorId}  SK: SLOT#{YYYY-MM-DD}T{HH:MM}
GSI1PK: SLOT_STATUS#{available|full}
GSI1SK: PROFESSOR#{professorId}#DATE#{YYYY-MM-DD}T{HH:MM}
fields: professorId, date, time, status, maxParticipants,
        currentParticipants, durationMinutes, topic?, isGroupSession?,
        createdAt
```

Consultation (one item per student-booking):
```
PK: CONSULTATION#{consultationId}   SK: METADATA
GSI1PK: PROFESSOR#{professorId}     GSI1SK: DATE#{YYYY-MM-DD}T{HH:MM}
GSI2PK: STUDENT#{studentId}         GSI2SK: DATE#{YYYY-MM-DD}T{HH:MM}
fields: consultationId, studentId, professorId, slotSK, date, time,
        status (booked|cancelled), topic, note, topicEmbedding?,
        isGroupSession?, createdAt,
        cancelledBy? (professor|student),  // set when status flips to cancelled
        cancelledAt?                       // ISO timestamp, set with cancelledBy
```

Chat session message (TTL = now + 86400s, i.e. 24h):
```
PK: SESSION#{sessionId}      SK: MSG#{epochMs}#{seq}#{uuid}
fields: role (user|assistant), contentBlocks (full Bedrock content array),
        ttl
```

Notification (TTL = now + 30 days):
```
PK: USER#{userId}            SK: NOTIF#{epochMs}#{uuid}
fields: userId, type, message, consultationId?, slotSK?, date?, time?,
        read, createdAt, ttl
```

Persisted daily report (TTL = now + 14 days):
```
PK: USER#{professorId}       SK: DAILY_REPORT#{YYYY-MM-DD}
fields: professorId, date, reportText, total, generatedAt, ttl
```

### DDB rules

- NO `scan()` ever
- NO `FilterExpression` as a substitute for proper key design
- `GSI1` and `GSI2` defined in CDK stack
- Node-side filtering only after a proper key-based query
- All slot/consultation writes that mutate capacity use `ConditionExpression`
  to avoid lost updates under concurrent bookings (see `bookSlotCore`,
  `joinGroupSession`).

## Cognito

- Single User Pool, email + password sign-in
- Custom attributes: `custom:role` (`professor` | `student` | `admin`),
  `custom:displayName`
- Password policy: min 8 chars, lowercase + digit required
- No MFA
- App client: SPA (no client secret), SRP auth flow + OAuth code grant for
  Hosted UI redirect
- Post-confirmation Lambda trigger writes the `USER#{sub}` PROFILE item
  to DynamoDB

## Bedrock

- Chat model: `eu.amazon.nova-lite-v1:0` (EU cross-region inference profile
  for `amazon.nova-lite-v1:0`; on-demand is not supported in eu-west-1)
- Embedding model: `amazon.titan-embed-text-v2:0` (on-demand in eu-west-1,
  256-dim normalized vectors) — used for semantic topic matching when
  proposing group sessions
- IAM grants InvokeModel on the inference profile + each EU region's
  foundation-model ARN + the embed model ARN
- Region: eu-west-1
- Client: `@aws-sdk/client-bedrock-runtime`

## Bedrock chat tools (function calling)

The chat handler hands the model a different toolset depending on the
caller's role:

### Student tools
1. `list_professors(nameFilter?, subjectFilter?, departmentFilter?)` —
   server does diacritic-insensitive matching across all three filters,
   returns `single_match | ambiguous | no_match | all`
2. `get_professor_slots(professorId, dateFrom, dateTo, topic?)` — returns
   `{ slots, joinableMatches }`. `slots` is the bookable list in the
   window. `joinableMatches` is a (usually empty) semantic match against
   upcoming group-friendly consultations with that professor — only
   populated when `topic` is passed. Folded in here (rather than a
   separate tool) so the model only surfaces grouping when there's an
   actual hit.
3. `book_slot(professorId, slotSK, note?)` — solo booking via shared
   `bookSlotCore`
4. `join_group_session(professorId, slotSK, note?)` — joins an existing
   group-friendly slot (`slotSK` from `joinableMatches`) inside the
   professor's stated cap, notifies existing participants. Does NOT
   auto-expand `maxParticipants`.
5. `get_my_consultations()` — upcoming consultations for current user
6. `cancel_consultation(consultationId)` — student cancels their booking,
   or professor cancels a booking on one of their slots

### Professor tools (used by the floating widget)
1. `get_my_consultations()` — upcoming consultations for the calling
   professor

The student system prompt enforces a topic-first / confirm-before-book
workflow (no tool other than `list_professors` may run until a topic is
in hand) and a mandatory two-turn confirmation for `cancel_consultation`.
For Reserve-button hand-offs that pre-fill date+time, a SHORTCUT runs
inside step 4 of the booking flow: the model verifies the chosen slot
exists in `get_professor_slots` and jumps straight to the confirmation
summary instead of presenting a numbered list of alternatives. It also
instructs the model to emit clickable `<picks>[{label,value}]</picks>`
JSON blocks when listing slot options, which the frontend renders as
buttons. The professor system prompt is read-only — booking, cancellation,
and messaging students are all explicitly disallowed.

Tool gating is enforced server-side too: even if the model attempts to
call a student-only tool from a professor session, `runTool` rejects it.

`POST /chat` returns `{ reply, sessionId, toolsUsed }`. `toolsUsed` is the
ordered list of tool names invoked during that turn; the frontend uses it
to drive a `bookingTick` (see `ChatWidgetContext`) so pages that render
schedule-derived state refetch when the chat just mutated something.

## CDK structure

- One stack: `UniConsultationsStack` in `infrastructure/lib/`
- Written in JavaScript
- Constructs: DynamoDB table + 2 GSIs, Cognito User Pool + Hosted UI
  domain + app client, all Lambdas, common Lambda layer
  (`/opt/nodejs/{db,consultations,embeddings,auth,response,logger}`),
  REST API Gateway (Cognito authorizer, CORS), S3 site bucket +
  CloudFront distribution (OAC), EventBridge daily rule for the report
- All Lambda env vars injected from CDK
- `dist/` is shipped via `BucketDeployment` if it exists at deploy time

## Lambda env vars

All Lambdas:
- `TABLE_NAME`
- `BEDROCK_MODEL_ID = "eu.amazon.nova-lite-v1:0"`
- `BEDROCK_EMBED_MODEL_ID = "amazon.titan-embed-text-v2:0"`
- `BEDROCK_REGION = "eu-west-1"`

All except the Cognito post-confirmation trigger:
- `USER_POOL_ID`
- `USER_POOL_CLIENT_ID`

Runtime: Node.js 22.x · memory: 256 MB · timeout: 30s · CommonJS modules.

## API routes (REST)

All routes require a valid Cognito ID token (Authorization header).
The `/chat` POST is throttled at 10 RPS / 20 burst.

Auth:
- `Cognito post-confirmation trigger` writes the user PROFILE item
  (no API route — invoked by Cognito)

Chat:
- `POST   /chat`                              — main assistant endpoint
- `GET    /chat/sessions/{sessionId}`         — replay a stored session for the calling user (Option A resume after refresh)

Professors directory:
- `GET    /professors`                        — paginated list
- `GET    /professors/{id}/slots`             — published slots in a window
- `POST   /professors/{id}/slots`             — owner publishes a block
- `PATCH  /professors/{id}/slots/{slotSK}`    — owner increases capacity
- `DELETE /professors/{id}/slots/{slotSK}`    — owner deletes one unbooked slot
- `POST   /professors/{id}/slots/cancel-day`  — owner wipes a whole day (cancels every booking, deletes the freed slots)

Professor schedule:
- `GET    /professors/{id}/unavailable`
- `POST   /professors/{id}/unavailable`
- `DELETE /professors/{id}/unavailable/{date}`
- `GET    /professors/{id}/classes`           — owner-only
- `POST   /professors/{id}/classes`
- `DELETE /professors/{id}/classes/{classId}`

Bookings & consultations:
- `POST   /bookings`                          — manual student-driven reservation (topic required, validated server-side)
- `GET    /me/consultations`                  — current user's upcoming consultations.
  - Students see every upcoming row of theirs, INCLUDING cancelled ones, so the My Reservations page can render "Cancelled by you / by professor" tombstones.
  - Professors see active rows + only those cancelled rows where the WHOLE session went away. Partial group cancels (one student dropped from a multi-person session) are hidden — the slot's participant count drops instead.
  - Each row carries `cancelledBy` / `cancelledAt` when applicable.
- `PATCH  /consultations/{id}`                — cancel a consultation (student or owning professor). Body may carry `{ status: "cancelled", reason?: string }`. The cancellation row is stamped with `cancelledBy` and `cancelledAt`. Notifications are symmetric: a professor cancelling notifies the student (reason appended when present); a student cancelling notifies the professor with the student's display name and topic. For multi-participant sessions where one student drops, the professor's notification reads as a "dropped from your group session" with the new participant count rather than a session-cancelled line.

Notifications (server-truth, no auto-clear on poll):
- `GET    /me/notifications`                  — paged newest-first
- `POST   /me/notifications/mark-all-read`
- `PATCH  /me/notifications/{notifId}`        — mark one read
- `DELETE /me/notifications/{notifId}`

Daily report:
- `GET    /me/daily-report`                   — latest persisted report for the calling professor
- `GET    /me/daily-report?date=YYYY-MM-DD`   — specific date

Analytics:
- `GET    /analytics/professor`               — own analytics (or admin can pass `?professorId=`)
- `GET    /analytics/admin`                   — admin-only cross-professor view

## Scheduled jobs

- `DailyReportRule` — EventBridge `cron(0 19 * * ? *)` triggers
  `daily-report` Lambda. It paginates through professors, queries each
  one's consultations for tomorrow, asks Bedrock for a short
  Serbian-language summary, and persists one row per professor per target
  date (PK=`USER#{professorId}`, SK=`DAILY_REPORT#{date}`, TTL = 14 days).
  The frontend reads it via `GET /me/daily-report` and shows it on the
  professor home page.

## Frontend structure

- Routes (see `App.jsx`):
  - Public: `/login`, `/register`, `/confirm`, `/callback`
  - Both roles: `/home`, `/my-consultations`
  - Student-only: `/chat`, `/professors`
  - Professor-only: `/availability`, `/calendar`
  - Professor + admin: `/analytics`
- The navbar (in `Layout.jsx`) is intentionally slimmer than the route
  list: students don't have a top-level "Academic Assistant" link
  (`/chat` is reachable from the floating widget's "Full view" action),
  and professors don't have a top-level "Calendar" link (`/calendar` is
  reachable from a CTA on the Reservations page). Both routes are still
  fully addressable for deep-links.
- Contexts: `AuthContext` (Amplify), `NotificationContext` (polls
  `/me/notifications` every 60s; pauses while the tab is hidden;
  read/unread state lives on the row, not in localStorage),
  `ChatWidgetContext` (lets any page imperatively open the student
  floating chatbot pre-filled with a message — used by the Professors
  page "Reserve" button to seed the topic-first booking flow — AND
  exposes a `bookingTick` counter that the chat surfaces bump every
  time the assistant ran a schedule-mutating tool. Pages whose data
  depends on the schedule subscribe to it and refetch).
- The student `/chat` page persists the last-used `sessionId` in
  `localStorage` and rehydrates messages from `GET /chat/sessions/{id}`
  on mount. Assistant `<picks>` blocks render as clickable buttons that
  re-send the chosen value on click.
- The student floating chatbot (`StudentChatWidget`, bottom-right) is the
  primary booking surface. It shares its `sessionId` with the full
  `/chat` page so the conversation stays continuous if a student opens
  the dedicated view. The widget is hidden on `/chat` to avoid double UI.
- The professor side gets a small floating chatbot widget
  (`ProfessorChatWidget`) for read-only schedule questions.
- The professor home page surfaces the persisted daily report
  ("Tomorrow at a glance").
- The Professors page (student) loads slots for each visible professor
  in parallel and shows distinct "group topics" chips on each card so
  active group sessions are discoverable before clicking. The "Reserve"
  button on a slot opens the floating chatbot with a pre-filled
  "I'd like to book Professor X on {day} at {time}" message rather than
  a modal form — manual and AI booking now share one funnel.
- My Reservations (`/my-consultations`):
  - Student view: editorial cards listing each upcoming OR cancelled
    booking with professor name + department, topic, time, and a colored
    rail (gold = 1-on-1, sage = group, danger = cancelled). Cancelled
    rows show a "Cancelled by you / by professor" tag.
  - Professor view: minimal rows grouped by parent block. Each row shows
    topic + student names + a small `n/M` capacity. Inline "Cancel with
    note" composer sends an explanatory notification to the affected
    student. Fully-cancelled slots collapse into a tombstone row with
    attribution; partial group cancels just decrement the participant
    count silently.
- Calendar (`/calendar`, professor-only): Google-Calendar-style Day /
  Week / Month grid backed by `GET /me/consultations`. Events are
  grouped by `slotSK` (one event per slot regardless of how many
  students are inside), color-coded (gold solo, sage group, striped
  danger fully-cancelled), and clickable for a detail dialog.
- Pages share a `Layout` (top nav, notification bell, footer; the
  professor widget and the student widget both mount here, gated by
  role and route).
- A small set of shared UI primitives keeps page chrome consistent:
  - `PageHeader` — eyebrow + display-serif title + optional lead and
    meta slot. Used by every authenticated page so titles, sizes, and
    spacing line up across Home, Faculty, Reservations, Office Hours,
    Calendar, Analytics, and Chat.
  - `StudentReservationCard` — editorial booking card used on the
    student Home "Upcoming" list (compact variant) and on My
    Reservations (full variant).
  - `ProfessorReservationBlock` — block-grouped reservation row used on
    the professor Home "Upcoming" list and on My Reservations (where it
    also exposes inline capacity edit and "Cancel with note" controls
    via a `manage` prop bundle).
  - `BrandMark` — navy shield with a gold serif "C" monogram, used in
    the header and login screens.
- Styling: CSS Modules + a global `index.css` defining the design
  tokens. Aesthetic is "university journal quarterly": Newsreader
  serif for display, Geist sans for body, Geist Mono for eyebrows and
  metadata. Palette is navy ink (`--ink`) on paper (`--paper`) with
  gold (`--accent` / `--accent-bright` / `--accent-deep`) and sage
  (`--sage`) as the institutional accents; `--danger` is reserved for
  cancelled-state semantics. Header carries a thin gold institutional
  banner stripe; the footer is styled as a publication colophon.

## Cost constraint

- Everything on-demand (PAY_PER_REQUEST for DynamoDB)
- No provisioned capacity, no NAT Gateway, no VPC
- Bedrock invocation is pay-per-call (Nova Lite + Titan embed)
