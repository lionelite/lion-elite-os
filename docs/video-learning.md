# Video Learning Connection

Feed a YouTube or Instagram video in; get a source-cited lesson in the
knowledge base out. Built so the owner can say "watch this and do it" without
retyping what the video said.

## What it actually does

1. **Parses the link** (`lib/video-learning/video-sources.js`) — every YouTube
   and Instagram URL shape collapses onto one canonical source, so the same
   video queued twice is the same lesson, not two.
2. **Gets the transcript** (`lib/video-learning/transcript-fetcher.js`) — four
   strategies, tried in order, described below.
3. **Extracts the lesson** (`lib/video-learning/lesson-extractor.js`) — summary,
   instructional lines, stated numbers, tools, chapters, and a compliance
   verdict. Every line keeps the timestamp it came from.
4. **Proposes work** (`lib/video-learning/task-proposal.js`) — each tactic is
   routed to a business lane, and anything implying a send, a publish, or spend
   is flagged with the control that gates it.
5. **Writes it down** (`lib/video-learning/lesson-store.js`) — one markdown file
   per video under `knowledge/video-lessons/`, plus a regenerated index.

Nothing in this pipeline publishes, sends, or spends. It reads videos and
writes notes.

## Using it

### Queue links (the normal path)

Edit [`knowledge/video-lessons/inbox.md`](../knowledge/video-lessons/inbox.md)
on the `automation/video-lessons` branch — from a phone, from the GitHub web
UI, whatever is at hand:

```
- https://youtu.be/VIDEOID — build an ad angle from this
- https://www.instagram.com/reel/SHORTCODE | steal the hook structure
```

The instruction can sit on either side of the link, and a dash, pipe, or colon
all separate it. Saving that file triggers the **Video Learning** workflow.
Processed links are removed from the queue; failed ones stay put with the
reason in the run summary.

### One-off

Run the **Video Learning** workflow from the Actions tab with a URL and a task,
or locally:

```bash
npm run learn:video -- https://youtu.be/VIDEOID --task="build an ad angle"
npm run learn:inbox                     # process everything queued
npm run learn:video -- <url> --dry-run  # report, write nothing
```

Useful flags: `--transcript-file=PATH` (supply a transcript yourself),
`--no-whisper` (never use the paid audio path), `--save-transcript`,
`--limit=N`, `--json`, `--base-dir=PATH`.

## How transcripts are obtained

| Strategy | Needs | Covers |
|---|---|---|
| `manual` | `--transcript-file` | anything, including Instagram posts with no captions |
| `yt-dlp` | `yt-dlp` binary | YouTube caption tracks, public Instagram reels |
| `youtube-page` | nothing | YouTube videos whose watch page exposes a caption track |
| `whisper` | `yt-dlp` + `ffmpeg` + `AI_API_KEY` | videos with no captions at all |

The first one that produces text wins. **When none of them do, the run writes
nothing** and reports what each strategy tried — a lesson invented from a title
would be worse than no lesson. Instagram is the common failure: it does not
serve captions to unauthenticated clients, so a private or caption-less reel
needs `--transcript-file`.

Audio transcription is the only step that costs money, and it only fires when a
video has no captions. In CI it is off unless the `VIDEO_TRANSCRIBE_AUDIO` repo
variable is `true`; locally, `--no-whisper` disables it. `VIDEO_TRANSCRIBE_MODEL`
overrides the model (default `whisper-1`).

**The dev sandbox cannot reach YouTube or Instagram** — the proxy answers 403
to both, the same gap that blocks `lionelitewellness.com`. Automatic fetching
works on the GitHub runner; locally, use `--transcript-file`.

## Compliance, and why lessons are quarantined by default

Creators say things Lion Elite Wellness legally cannot repeat: dosing, human
use, transformation promises. Every transcript is checked against both brand
rule sets in `lib/social/social-compliance.js`, and a lesson that trips either
one is marked **internal only** — the mechanism may be worth adopting, the
wording never ships. Proposals inherit that verdict.

The research disclaimer is deliberately *not* required here. A third party's
transcript is source material, not published copy; demanding a disclaimer would
block every video and teach everyone to ignore the gate.

Lessons are recorded as **operational inference** under the knowledge base's
update standard — what someone said in a video, not something Lion Elite has
verified. Numbers are labelled as claimed by the creator. Promote a tactic to a
durable rule only after it has actually been tried, and record that in the
relevant `knowledge/` file rather than leaving it as a video note.

## Where output lands

`main` requires the `test` status check, which a notes-only bot push can never
satisfy, so lessons commit to the unprotected **`automation/video-lessons`**
branch — the same pattern as the daily agent and social content workflows. The
branch is created from `main` rather than orphaned, so the workflow file exists
there and inbox edits on that branch trigger a run.

Full transcripts are not committed by default: they are third-party content,
they bloat diffs, and the timestamp links already point at the source. Pass
`--save-transcript` when a working copy is genuinely needed.

## Tests

`test/video-learning-sources.test.js`, `-parsers`, `-lesson`, and `-store` cover
URL parsing, all four caption formats (including YouTube's rolling-caption
duplication), utterance rebuilding, extraction, the compliance gate, hard-limit
flagging, rendering, and the inbox round-trip. They are pure — no network, no
`yt-dlp` — and run in the root `npm test`.
