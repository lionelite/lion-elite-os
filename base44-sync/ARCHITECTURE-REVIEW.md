# Base44 architecture review — ProfitFlow, ZenFlow, and `coaching_*`

Scope: the review requested in `CLAUDE_HANDOFF.md` §"What Claude Code should do
now" item 2, plus §"Priority engineering review".

Inputs are the two schema snapshots in this directory **only**. No Base44 source
was available (`PREMIUM_REQUIRED`), so every finding below is a
*schema-level* finding. Nothing here is reconstructed application code, and
nothing claims to describe Base44 business logic that isn't implied by the
entity/field lists themselves. Findings that cannot be settled without the real
source are marked **BLOCKED**.

## 0. The framing the handoff is missing: this is a three-way comparison

`CLAUDE_HANDOFF.md` asks whether to consolidate on ProfitFlow's or ZenFlow's
model. But `lionelite/lion-elite-os` already contains a **third, live,
Postgres-backed implementation of the same domain** — 17 tables in
`db/schema.sql`:

```
coaching_subscriptions   coaching_workout_plans      coaching_messages
subscription_events      coaching_workout_days       coaching_checkins
coaching_clients         coaching_workout_exercises  coaching_push_subscriptions
coaching_invites         coaching_workout_logs       coaching_audit_events
coaching_sessions        coaching_nutrition_plans
coaching_exercises       coaching_supplement_plans
                         coaching_peptide_protocols
```

It is served by `routes/coaching.js` + `lib/coaching/*` and deployed as the PWA
at `/coaching/`. On the dimensions the handoff asks about — ownership,
isolation, workout normalization, invites, compliance — **it is ahead of both
Base44 apps** (evidence in each section below).

So the real question is not "ProfitFlow or ZenFlow". It is: *does Base44 remain
the runtime for these two apps at all, given the target architecture already
exists here with constraints the Base44 models can't express?* That is an owner
decision, not one to settle in a refactor. Sections 1–9 are written so the
answer is useful either way.

## 1. Ownership and role consistency — highest structural risk

**ProfitFlow stores coach assignment twice.** `Client.coach_id` and
`User.assigned_coach_id` are independent fields. Nothing in a schema keeps them
equal. If row-level security reads one and the UI filters on the other, the two
failure modes are a client appearing under the wrong coach, or a coach locked
out of an assigned client. **BLOCKED**: which field the Base44 RLS rule
actually names is not visible in the snapshot — this is the single most
important thing to read first when source access opens.

**ZenFlow denormalizes ownership onto every row.** `ProgressPhoto`, `Program`,
`CheckIn`, `Workout`, `WorkoutExercise`, `NutritionPlan`, `Message`, and
`WorkoutLog` all carry **both** `client_id` and `user_id`. The invariant
`row.user_id == Client(row.client_id).user_id` is assumed everywhere and
enforced nowhere. A row that violates it is either invisible to its owner or
visible to someone else, depending on which column the policy tests.

**ZenFlow has no coach role.** `User.role` is `admin/user` — yet the schema
carries `CoachNote`, `Workout.coach_notes`, `WorkoutExercise.coach_notes`, and
`Client.coach_notes`. Coaching in ZenFlow is therefore admin-only, while in
ProfitFlow `coach` is a first-class role with its own access tier. Any
consolidation must pick one; they are not reconcilable by renaming.

**Contrast.** `coaching_sessions` derives identity from the session itself —
`actor_type IN ('coach','client')` with
`CHECK ((actor_type='client' AND client_id IS NOT NULL) OR actor_type='coach')`.
Ownership is not a field on each row that can drift; it is established once at
authentication. That is the pattern to move toward.

## 2. Row-level security and client data isolation

**"Coach notes" are client-readable in both Base44 apps.** `CoachNote` is
correctly restricted (ProfitFlow: admin/coach; ZenFlow: admin-only). But the
*fields* named `coach_notes` sit on client-readable rows — ProfitFlow
`Workout.coach_notes` and `CheckIn.coach_response`; ZenFlow `Workout.coach_notes`,
`WorkoutExercise.coach_notes`, `Client.coach_notes`. A coach who has learned
that `CoachNote` is private will reasonably assume a field called `coach_notes`
is too. It is not. This is a privacy trap created by naming, and it exists in
both apps. Recommend renaming the client-visible ones to `client_guidance` (or
similar) so the private/visible split is legible at the field name.

**Photo URLs may not be covered by row security.** ZenFlow `ProgressPhoto.image_url`,
`ProfitFlow ProgressMeasurement.photo_url`, `NutritionEntry.photo_url`. If these
resolve to unauthenticated object-storage URLs, RLS on the row protects the
*reference* and not the *image* — and progress photos are the most sensitive
data either app holds. **BLOCKED** on Base44 file-storage semantics. Treat as
high severity until disproven.

**ZenFlow invites are the one thing done right.** `AppInvite.token_hash` stores
a hash, not a plaintext token — matching `coaching_invites.token_hash TEXT NOT
NULL UNIQUE` here. Keep this on any migration path.

## 3. Workout and program normalization

| | ProfitFlow | ZenFlow | `coaching_*` |
|---|---|---|---|
| Exercise library | none | `Exercise` | `coaching_exercises` |
| Prescription | `Workout.exercises` array | `Program→Workout→WorkoutExercise` | `plans→days→exercises` |
| Performance record | none | `WorkoutLog` | `coaching_workout_logs` |

**ProfitFlow embeds exercises as an array** with sets/reps/load/RPE/rest/video
per entry and no library behind it. Consequences: no reuse, video URLs
duplicated per workout per client, renaming an exercise is unbounded find-and-
replace, and "which clients are doing X" is unanswerable. ZenFlow's direction is
correct and should win this comparison.

**But ZenFlow has two defects the normalization doesn't fix.**
`WorkoutExercise` stores `exercise_id` *and* `name` — renaming the library
entry leaves stale names on historical rows. (Sometimes deliberate, to preserve
what was prescribed at the time; if so it should be `name_at_prescription`.) In fairness,
`coaching_workout_exercises` here does the same thing — `exercise_id` plus a
`name TEXT NOT NULL`, with `ON DELETE SET NULL` on the library reference, which
suggests the denormalization *is* deliberate snapshotting. If so, ZenFlow's is
probably deliberate too, and this drops from a defect to a naming issue in both.
And `WorkoutLog.performance_json` is an unstructured blob, which discards the
per-exercise structure `WorkoutExercise` just established — "did the client hit
prescribed reps" requires parsing JSON in the application instead of a join.

**ProfitFlow has no performance record at all.** `Workout.status` is the only
completion signal — prescribed-vs-performed cannot be computed. That is a
functional gap, not a modeling preference.

**Scheduling ambiguity (ZenFlow):** `Workout` carries both `day_order`
(relative) and `scheduled_date` (absolute). Which governs when a program start
date shifts is undefined. `coaching_workout_days` uses relative ordering only,
resolved against the plan — cleaner.

## 4. Message ownership and read state

**ProfitFlow `Message.read` is a boolean shared by two parties.** One flag
cannot represent "coach has read" and "client has read" separately. Whoever
reads first clears the other's unread badge. ZenFlow's `read_at` timestamp is
better typed but has the identical two-reader bug.

**ProfitFlow additionally denormalizes an unread counter onto `Client`**
("unread messages"). It will drift from the `Message` table on any failed write,
deletion, or concurrent read.

Fix in either case: read state belongs in a per-recipient row, or as two
explicit columns (`coach_read_at`, `client_read_at`). Note `coaching_messages`
has the same single `read_at` — this finding applies to all three
implementations and is worth fixing here regardless of what happens to Base44.

`coaching_messages` does add two things both Base44 apps lack: a `system` sender
type, and `CHECK (char_length(body) BETWEEN 1 AND 2000)`.

## 5. Invite and onboarding flows

**ZenFlow `AppInvite` encodes state three ways** — `status`, `expires_at`,
`used_at` — which can disagree (`status='pending'` with `expires_at` in the
past). Derive status from the timestamps rather than storing it alongside them,
as `coaching_invites` does (`expires_at` + `redeemed_at`, no status column).

**Onboarding state is encoded three different ways across the two apps:**
ProfitFlow `Client.status` and `User.onboarding_status`; ZenFlow `Client.status`
and `Client.onboarding_completed`. ProfitFlow splits lifecycle across two
tables; ZenFlow mixes an enum with a boolean. Neither is consistent.

## 6. Check-in lifecycle and coach response

**ProfitFlow's check-in is far richer** (hunger, training_performance,
nutrition_adherence, recovery, wins, problems, questions) than ZenFlow's
(adherence, wins, challenges). On content, ProfitFlow wins.

**ZenFlow has no coach response path at all** — `submitted_at` but no status and
no response field. Check-ins are write-only from the client; the coaching loop
is missing.

**Neither app can measure coach response time.** ProfitFlow has `coach_response`
(a single string — no threading, no read receipt) but no `responded_at`. For a
coaching business, time-to-response is the core service metric and neither
schema can report it. Recommend `responded_at` regardless of which model wins.

**Neither app range-checks anything.** `coaching_checkins` constrains
`weight_lbs BETWEEN 50 AND 1000`, `sleep_hours BETWEEN 0 AND 24`, and
`energy`/`adherence`/`soreness BETWEEN 1 AND 10`. The Base44 snapshots show
untyped equivalents.

## 7. Nutrition — plan vs log are complementary, not duplicate

ProfitFlow has `NutritionEntry` (a **log**: per-meal food, macros, photo,
adherence, coach feedback). ZenFlow has `NutritionPlan` (a **prescription**:
calorie/protein/carb/fat targets, `meal_plan_json`). **Neither app has both.** A
consolidated model needs both, and adherence should then be *computed* from log
against plan — ProfitFlow's `adherence` is a hand-entered field that can
contradict the macros logged next to it.

`meal_plan_json` is another unqueryable blob, same objection as
`performance_json`.

## 8. Supplement and peptide entities — compliance, not modeling

**This is the highest-stakes finding in the review.**

ProfitFlow `Supplement` carries `client_id`, `name`, `instructions`, `timing`,
and a `type` that includes **`peptide`**. That is a schema which permits
assigning a peptide, with dosing instructions and timing, to a named human
client. It is *structurally* human-use direction, and it sits directly against
the Research-Use-Only posture that governs this organization
(`CLAUDE.md` hard limits; `lib/social/social-compliance.js` blocks exactly this
language in every other channel — email, SMS, social).

Compare `coaching_peptide_protocols` in this repo, which models the same need
with the control attached:

```sql
clinician_name       TEXT NOT NULL DEFAULT '',
clinician_confirmed  BOOLEAN NOT NULL DEFAULT false,
status               TEXT CHECK (status IN ('draft','published','archived')),
CHECK (status <> 'published' OR clinician_confirmed = true)
```

A protocol **cannot reach `published` without a confirmed clinician** — enforced
by the database, not by application code or reviewer diligence. ProfitFlow's
`Supplement` has no equivalent and, as a Base44 entity, likely cannot express
one.

ZenFlow has no supplement entity at all.

**Recommendation:** treat ProfitFlow's `Supplement.type='peptide'` path as
requiring a compliance decision *before* any reconstruction, migration, or
refactor touches it — not after. If ProfitFlow is already live with client
peptide assignments, that is worth reviewing on its own merits, independently of
this consolidation work. I have not changed anything here; flagging only.

## 9. Date/time semantics

**Mixed date and timestamp conventions.** ProfitFlow uses bare `date` on
Workout / NutritionEntry / CheckIn / Task / ProgressMeasurement. ZenFlow uses
timestamps with inconsistent naming (`scheduled_date`, `taken_at`,
`submitted_at`, `sent_at`, `read_at`, `completed_at`, `start_date`, `end_date`,
`expires_at`, `used_at`). All `coaching_*` columns are `TIMESTAMPTZ`.

**No timezone on Client or User in either app.** "Check-in due Monday" is
ambiguous for a client in another timezone. This matters more here than in a
generic app: this repo already enforces recipient-local quiet hours for SMS
(8am–9pm, unknown timezone fails closed, per `docs/sms-campaigns.md`). If
coaching notifications are ever driven off these dates, they need the same
timezone data — and neither Base44 app carries it.

**Two renewal dates (ProfitFlow):** `Client.renewal_date` and
`User.renewal_date`. Two sources of truth for when access ends — and this repo
already owns subscription entitlement in `coaching_subscriptions` +
`subscription_events`, with access termination logic added in `8b1d7fe`
("End coaching access when the subscription ends"). Three systems, one question.
Entitlement should have exactly one owner.

## 10. Duplicate and conflicting concepts

- `Task` means two different things: client-scoped homework (ProfitFlow) vs a
  generic project manager with `Subtask`/`Project` (ZenFlow). Same name, unrelated
  concepts — do not merge on name.
- Client lifecycle: three encodings (§5).
- Renewal/entitlement: three owners (§9).
- Coach assignment: two fields (§1).

## Recommended sequence

1. **Owner decision first:** does Base44 stay the runtime for ProfitFlow and
   ZenFlow, given `coaching_*` already implements this domain with constraints
   Base44 entities can't express? Everything downstream depends on this answer,
   and it is not mine to make.
2. **Compliance decision on §8** — independent of #1, and more urgent than it.
3. **Fix in this repo now, no Base44 access needed:** the two-reader `read_at`
   bug in `coaching_messages` (§4), and `responded_at` on check-ins (§6).
4. **Base44 change requests** (per handoff item 5) — deferred pending #1, since
   they are wasted effort if the apps migrate rather than stay.
5. **On Builder access:** read the actual RLS policy expressions first — §1 and
   §2 are the findings a schema snapshot cannot settle, and both are security
   findings.

## Confidence and limits

Sections 1–10 follow from the field lists in the two snapshots and from
`db/schema.sql`, which I read directly. Items marked **BLOCKED** cannot be
settled without Base44 source. I have not reconstructed any Base44 application
code, and no proposed implementation appears in this document — consistent with
handoff rules 6 and 7.
