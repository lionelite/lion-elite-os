# Multi-coach access control

The coaching portal originally had one credential: `COACH_PORTAL_ADMIN_TOKEN`.
Anyone holding it got a session with `actor_type = 'coach'` and no identity, and
every `/admin/*` route served every client to any such session. Adding a second
coach was therefore impossible without handing over the whole client roster.

Coaches are now rows, client ownership is a foreign key, and each `/admin/*`
route is scoped to the acting coach.

## Roles

| Role | Sees | Can administer coaches |
|---|---|---|
| `owner` | every client on the platform, assigned or not | yes |
| `coach` | only clients whose `coach_id` is theirs | no |

There is normally one owner: the business owner. Every other coach is `coach`.

## Signing in

Each coach has their own access token. Only the SHA-256 hash is stored
(`coaching_coaches.access_token_hash`), so a token is **shown once** — at
creation and at rotation — and a lost one is rotated, never recovered.

`COACH_PORTAL_ADMIN_TOKEN` is the owner's token and the upgrade path from the
old model. Signing in with it:

1. finds the owner row, or creates one if this is the first sign-in;
2. re-points the existing owner row if the env value was rotated;
3. claims every client with a `NULL coach_id` for the owner.

Step 3 is what makes the migration safe: clients created before this change, and
clients created by Stripe checkout (which has no acting coach), are never
stranded invisible. `COACH_OWNER_NAME` sets the name clients see on the owner's
messages; it defaults to `Coach Alex`, the name the portal used before coaches
had identities.

## What is scoped

- **Roster** — `GET /admin/clients` filters by `coach_id` for a coach; an owner
  passes `null` and sees everything.
- **Every client-addressed route** — `requireClientAccess` loads `:clientId` and
  rejects it unless the acting coach owns it or is the owner.
- **Plan-addressed routes** — publishing a workout or care plan resolves the
  plan's owning client first, so a plan id cannot be used to reach around the
  client check.
- **Message stream** — the SSE bucket is keyed `coach:<coachId>`. It was the
  literal string `coach`, so every signed-in coach received every client's
  messages live.
- **Push subscriptions** — carry `coach_id`, and a client's message alert goes
  only to that client's own coach. Previously one client message notified every
  coach's device.
- **Message sender name** — the acting coach's real name. It was hardcoded
  `'Coach Alex'` for everyone.

### Deliberately shared

The **exercise video library** is shared across all coaches. It is a library of
approved demonstration videos, not client data, and a workout cannot publish
without video coverage — so a per-coach library would mean each new coach starts
unable to publish anything. Any active coach may add to it.

## Why 404 and not 403

A coach reaching another coach's client gets **404**, not 403. A 403 would
confirm the id exists, which turns the endpoint into a probe for the size and
membership of other coaches' rosters. The client simply does not exist as far as
that coach is concerned.

## Suspension and rotation

Both take effect immediately, not at cookie expiry:

- `PATCH /admin/coaches/:coachId` with `status: 'suspended'` deletes that
  coach's sessions, and `getSession` refuses any session whose coach row is not
  `active`.
- `POST /admin/coaches/:coachId/token` issues a new token and deletes existing
  sessions, so the old token and any live cookie both stop working.

An owner cannot suspend their own account — that would lock the only owner out
of coach administration.

## Migration notes

`db/schema.sql` is idempotent and safe to re-run. It adds `coaching_coaches`,
adds `coach_id` to `coaching_clients`, `coaching_sessions`, and
`coaching_push_subscriptions`, and then deletes coach sessions and coach push
subscriptions that have a `NULL coach_id`. Those are pre-migration rows with no
identity, so no policy can scope them; dropping them costs one re-login and one
re-subscribe. **Client sessions are untouched** — clients stay signed in on
their phones.

## Adding a coach

Owner → **Coaches** tab → *Add a coach* → copy the access token and send it to
them privately. They sign in at the same `/coaching/` URL with that token and
see an empty roster until they add clients or the owner assigns some (an owner
may pass `coachId` when creating a client; a coach may not).

## Tests

`test/coaching-multi-coach.test.js` covers the boundary: roster scoping, 404 on
every client-addressed route, plan-publish scoping, owner-only administration,
immediate suspension and rotation, per-coach push routing, sender naming, and
that editing a client never moves it to another roster.
