# Base44 ProfitFlow schema snapshot

App ID: `6a96da19bdddc166b7ea1b82`

This app currently exposes the following entities through Base44's schema API. Claude Code should treat this file as a partial architectural snapshot until direct Base44 sandbox/file access is enabled.

## Entities

- Client: name, avatar_color, user_id, coach_id, is_vip, status, program, activity/check-in/adherence fields, category, renewal_date; role-aware row-level security for admin/coach/client.
- CoachNote: client_id, coach_id, body, category; admin/coach access.
- Workout: client_id, title, date, status, exercises array with sets/reps/load/rate-of-perceived-exertion/rest/video/notes, coach_notes, duration; admin/coach/client row-level security.
- NutritionEntry: client_id, date, meal, food, calories, protein, carbohydrates, fat, photo_url, adherence, coach_feedback.
- Supplement: client_id, name, instructions, timing, coach_notes, status, type including supplement or peptide.
- CheckIn: client_id, date, status, weight, sleep, energy, stress, hunger, training_performance, nutrition_adherence, recovery, wins, problems, questions, coach_response.
- Message: client_id, coach_id, sender, body, attachment_url, read.
- Task: client_id, title, type, date, completed.
- ProgressMeasurement: client_id, date, weight, body_fat, body measurements, photo_url, metric_type.
- User: role admin/coach/client, avatar_color, phone, is_vip, assigned_coach_id, onboarding_status, goals, limitations, training_experience, equipment, renewal_date.

## Important architecture observations

This is a coaching/client platform with workouts, nutrition, supplements/peptides, check-ins, messaging, tasks, progress tracking, coach notes, role separation, and onboarding. Claude Code should preserve role-based data isolation and should not weaken row-level security when refactoring.

## Current blocker

Base44 direct file and shell access returned `PREMIUM_REQUIRED`: external coding agents require the Base44 Builder plan or above. Once enabled, export/sync the full application source into GitHub and replace this snapshot with actual code paths and build instructions.
