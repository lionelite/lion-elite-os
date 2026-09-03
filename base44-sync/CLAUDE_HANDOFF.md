# Claude Code Base44 Handoff

## Objective
Help improve and maintain the Base44 applications even while direct Base44 sandbox/source access is restricted by the current workspace plan.

## Current Base44 applications
- ProfitFlow — Base44 app id `6a96da19bdddc166b7ea1b82`
- ZenFlow — Base44 app id `6a85c66afdcf541c21211c65`

## Important access constraint
Direct Base44 file/shell sandbox access currently returns `PREMIUM_REQUIRED` and requires the Base44 Builder plan or above. Do not pretend the original Base44 React/source tree is present in this repository until it has actually been exported.

Until full source is available, use the schema snapshots in this directory as the source of truth for data architecture and authorization behavior. Do not weaken row-level security rules when reconstructing or proposing application code.

## ProfitFlow application architecture
The connected ProfitFlow application is a coaching/client application with these entities:

- `Client`: name, user assignment, coach assignment, VIP state, coaching status, program, activity timestamps, adherence, unread messages, next action, category, renewal date.
- `CoachNote`: client, coach, note body, category.
- `Workout`: client, title, date, status, exercise array, notes, duration.
- `NutritionEntry`: client, date, meal, food, calories, protein, carbohydrates, fat, photo, adherence, coach feedback.
- `Supplement`: client, name, instructions, timing, coach notes, status, supplement/peptide type.
- `CheckIn`: client, date, status, weight, sleep, energy, stress, hunger, training performance, nutrition adherence, recovery, wins, problems, questions, coach response.
- `Message`: client, coach, sender role, body, attachment, read state.
- `Task`: client, title, type, date, completion state.
- `ProgressMeasurement`: client, date, weight, body fat, measurements, photo, metric type.
- `User`: admin/coach/client role, phone, VIP state, assigned coach, onboarding status, goals, limitations, training experience, equipment, renewal date.

Security model: admins and coaches have broad coaching access; clients are restricted to their own client-linked records. Preserve this behavior exactly unless a deliberate security change is reviewed.

## ZenFlow application architecture
The connected ZenFlow application includes:

- `Task`, `Subtask`, `Project`
- `ProgressPhoto`
- `Program`
- `CheckIn`
- `Workout`
- `WorkoutExercise`
- `WorkoutLog`
- `NutritionPlan`
- `Message`
- `CoachNote`
- `AppInvite`
- `Client`
- `Exercise`
- `User`

The application contains a more normalized coaching architecture: programs own workouts, workouts own exercises, users/clients are linked by `user_id`, client-facing records use row-level security, and administrative records are restricted to administrators.

## What Claude Code should do now
1. Treat the Base44 schema snapshots as authoritative contracts.
2. Review the two models and identify duplication, broken relationships, authorization risks, naming inconsistencies, and migration hazards.
3. Prefer the normalized structure where it materially improves maintainability, but do not silently change live Base44 schemas.
4. Prepare migration-safe code, tests, adapters, and documentation in GitHub first.
5. For any change that requires modifying the Base44 app itself, output the exact Base44 change request and affected entities/files so it can be applied through the Base44 builder while sandbox access remains restricted.
6. Never invent missing Base44 source code. Clearly mark reconstructed code as a proposed implementation.
7. Once a real Base44 source export becomes available, replace reconstructed assumptions with the actual files and run a full diff before making changes.

## Priority engineering review
Claude Code should focus on:

- Role and ownership consistency between `User`, `Client`, coach, and administrator records.
- Row-level security correctness and client data isolation.
- Workout/program relationship normalization.
- Message ownership and unread/read-state behavior.
- Invite and onboarding flows.
- Check-in lifecycle and coach response workflow.
- Progress photo ownership and privacy.
- Exercise library reuse and workout logging.
- Nutrition plan versus nutrition entry separation.
- Consistent date/time semantics.
- Removal of duplicate or conflicting model concepts only through migration-safe changes.

## Handoff rule
The repository is the collaboration layer for Claude Code. Base44 remains the live application runtime until a verified migration/export exists. Changes should be proposed and tested here, then deliberately applied to Base44; never assume GitHub changes automatically modify the live Base44 app.