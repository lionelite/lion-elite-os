# Base44 ZenFlow schema snapshot

App ID: `6a85c66afdcf541c21211c65`

This app currently exposes the following entities through Base44's schema API. Claude Code should treat this as a partial architecture snapshot until direct Base44 sandbox/file access is enabled.

## Entities

- Task: title, description, status, priority, due_date, project_id, project_name.
- Subtask: task_id, title, done, order.
- ProgressPhoto: client_id, user_id, image_url, photo_type, taken_at, notes, with client/admin row-level security.
- Program: client_id, user_id, title, goal, status, start_date, end_date, notes.
- CheckIn: client_id, user_id, weight, sleep, energy, stress, adherence, wins, challenges, notes, submitted_at.
- Workout: program_id, client_id, user_id, title, day_order, scheduled_date, status, estimated_minutes, coach_notes.
- WorkoutExercise: workout_id, client_id, user_id, exercise_id/name, order, sets, reps, rest_seconds, tempo, coach_notes, video_url.
- NutritionPlan: client_id, user_id, title, status, calorie_target, protein_grams, carbohydrate_grams, fat_grams, guidance, meal_plan_json.
- Message: client_id, user_id, sender_role, body, read_at, sent_at.
- CoachNote: client_id, title, body, pinned, category; admin-only.
- AppInvite: client_id, email, token_hash, status, expires_at, used_at, sent_at; admin-only.
- WorkoutLog: client_id, user_id, workout_id, completed_at, effort, duration_minutes, feedback, performance_json.
- Client: user_id, first_name, last_name, email, status, primary_goal, coach_notes, limitations, preferred_checkin_day, training_days_per_week, session_minutes, sleep_hours, activity/check-in timestamps, onboarding_completed.
- Exercise: name, category, equipment, video_url, thumbnail_url, instructions, default_sets, default_reps, active.
- Project: name, description, color.
- User: role admin/user.

## Important architecture observations

This is also a coaching/client application with a more normalized training model: programs -> workouts -> workout exercises -> workout logs, plus nutrition plans, check-ins, progress photos, messages, invites, tasks, and client records. Claude Code should compare this structure with ProfitFlow before consolidating or selecting a canonical app architecture.

## Current blocker

Base44 direct file and shell access returned `PREMIUM_REQUIRED`: external coding agents require the Base44 Builder plan or above. Once enabled, sync the full Base44 source into GitHub so Claude Code can operate on the actual components, functions, routes, styles, and configuration.
