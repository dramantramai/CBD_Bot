# CBD Auto-Fill Bot

Drafts Dramantram's Client Brief Document from a Teams meeting transcript.

A client meeting ends, the bot checks whether it was actually a client meeting,
pulls the transcript, extracts the brief's fields with Gemini, fills the real
`.docx` template and sends it to the attendee in Teams. Internal standups are
ignored. Fields the transcript did not clearly support are tagged
`[NEEDS CONFIRMATION]` for a human to fix rather than quietly guessed.

## Run it right now, with no credentials

```bash
npm install
cp .env.example .env
node scripts/testE2E.js
```

`MOCK_MODE=true` (the default) routes Graph, Teams and the LLMs to fixtures and
an offline extractor, so the full pipeline runs with nothing configured. It
writes real documents to `dist/output/` — open one in Word to see the result.

```bash
node scripts/testE2E.js client-meeting   # one fixture
node scripts/testE2E.js --real           # same run, but against the live LLMs
npm test                                  # unit tests
```

`testE2E.js` checks the pipeline's plumbing — filter decision, document
generation, the XML actually inside the `.docx`, the database row — so it runs
on the offline extractor by default. That keeps its assertions deterministic and
stops a routine run from spending real daily quota. `--real` exercises the live
provider chain when that is what you want to test.

## Draft a brief from your own transcript

```bash
node scripts/brief.js path/to/meeting.vtt --title "Acme x Dramantram - Kickoff"
```

Takes a Teams `.vtt` export or a plain `.txt` of notes, prints every extracted
field with its confidence score, and writes the `.docx`. No Teams, no Graph, no
Azure. Useful flags:

| Flag | Why |
|---|---|
| `--title` | The meeting title is the best source of the client name |
| `--owner` / `--email` / `--phone` | Fill the project-owner row |
| `--attendee "Name:email@client.com"` | Comma-separate several; drives SPOC matching |
| `--provider gemini\|groq\|huggingface\|mock` | Force one, instead of the usual chain |
| `--print-prompt` | See exactly what would be sent to the model |
| `--json` | Write the extracted JSON beside the document |

### Turning on real extraction

Extraction is gated on an API key, **not** on `MOCK_MODE`, so you get a real
model while Teams and Graph stay stubbed:

1. Get a free key at [aistudio.google.com](https://aistudio.google.com/apikey).
2. Put it in `.env` as `GEMINI_API_KEY=...`.
3. Re-run `scripts/brief.js`. It prints which provider answered.

With no key it uses the offline heuristic extractor and says so in yellow. That
extractor is for development only — it is regex heuristics, and on an unfamiliar
transcript it misses things a model catches. `FORCE_MOCK_LLM=true` keeps it in
use even when a key is present.

### Staying inside the free tiers

Gemini's free quota is granted **per model**, not per project — the quota id in
the 429 reads `GenerateRequestsPerDayPerProjectPerModel`. So the bot rotates
through a list (`GEMINI_MODELS`) and a model that is used up for the day simply
steps aside for its siblings. Measured capacity across the list: **200
requests/day**, against ~30 meetings/day for a 30-person office.

Quotas are not equal, and the cheap models win twice over:

| Model | Requests/min | Requests/day |
|---|---|---|
| `gemini-3.5-flash-lite` | 15 | **50** |
| `gemini-3.1-flash-lite` | 15 | **50** |
| `gemini-3.6-flash`, `-3-flash-preview`, `-3.5/3.7/3.8-flash` | 5 | 20 |
| any Pro model | 0 | 0 — paid only |

The `-lite` models carry 2.5x the daily allowance and 3x the rate, answer in
~4 s rather than ~26 s, and 503 far less often, while scoring identically on the
same transcript (4.41/5). They lead the list for all three reasons.

Not on the list, deliberately: the `2.5-*` models (the API returns 404, "no
longer available to new users", even though the dashboard still lists them),
every Pro model (no free quota at all), and `-preview` aliases of a model
already listed — those share the parent's quota and only waste an attempt.

`src/llm/modelHealth.js` decides how long each kind of refusal benches a model:

| Refusal | Bench | Why |
|---|---|---|
| Daily quota gone | 6 h | Nothing changes until Google's reset |
| Rate limited | the delay the API asks for | It tells us; honour it |
| 503 overloaded | 2 min | Transient, and worst on the newest models |
| 404 retired | forever | It is not coming back |
| 413 too large | **not benched** | The request is the problem, not the model |

That last row matters: every Groq model shares one per-minute token ceiling, so
benching one over an oversized transcript would wrongly block later, shorter
meetings. Instead the chain falls through to Gemini, whose per-minute budget is
large enough for an hour-long transcript.

Two measured caveats worth knowing:

- **Groq cannot take a 60-minute meeting on the free tier.** Its ceiling is
  8,000 tokens/minute and a realistic hour-long transcript costs ~11,900. It
  returns a hard 413, not a throttle. Gemini handles those.
- **The newest Gemini models 503 most often.** The list is deliberately ordered
  with the `-lite` models first: measured on the same hour-long transcript they
  were the most available, the fastest (~4 s vs ~26 s), and scored identically
  (4.41/5). Newer is not better here.

The three fixtures each prove a different branch:

| Fixture | Proves |
|---|---|
| `client-meeting` | External attendees, 38 min → brief generated |
| `internal-standup` | All `@dramantram.com`, 12 min → skipped silently |
| `ambiguous-meeting` | A dial-in with no email → bot asks before briefing |

## How it fits together

```
meeting ends
  → Graph change notification            src/routes/webhook.js
  → is this a client meeting?            src/filter/smartFilter.js
  → fetch transcript (dual path)         src/graph/transcripts.js
  → extract fields + confidence          src/llm/extractCBD.js
  → fill the .docx                       src/docgen/fillTemplate.js
  → send it in Teams                     src/bot/proactive.js
```

`src/pipeline.js` is that sequence; the webhook and the E2E script both call it,
so the offline run exercises the same code path as production.

### The filter

Three steps, in order: any attendee outside the tenant domain, then at least
15 minutes, then process. An attendee with no resolvable email (a phone dial-in)
means the bot cannot prove either way, so it asks and auto-skips after 2 hours.

### Transcript access

Application permissions can only see meetings hosted on the Dramantram tenant.
When a client hosts, the transcript lives on *their* tenant, so the bot reuses
the attendee's own delegated access from a one-time Teams SSO sign-in. It tries
the application path first and falls through on 401/403/404.

### The document

The template's 51 checkboxes are real Word content controls, not text. Ticking
one means flipping its `w14:checked` flag, its run font and its glyph together —
change only some and Word renders a broken box. `src/docgen/checkboxMap.json`
and `templateMap.json` are generated from the template itself:

```bash
npm run build:template-map   # re-run only if template.docx changes
```

Field enums in `src/llm/schema.json` come from the same pass, so the LLM can
never be told about an option the document does not have.

### Confidence

Every field is scored 1–5. Below 3 gets `[NEEDS CONFIRMATION]` in red in the
document, and the Teams card says how many fields need a look. A brief that
admits what it guessed is more useful than one that reads as finished.

## Going live

Everything below needs access this repo cannot provide. Each has a `TODO` at the
point in the code where it matters.

1. **Azure AD app** — register it, add these delegated permissions plus
   `offline_access`, and grant admin consent:
   `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All`, `User.Read`,
   `Chat.ReadWrite`. Keep the application-level permissions too; they serve the
   faster path for Dramantram-hosted meetings.
2. **Bot registration** — create the Azure Bot resource, point its messaging
   endpoint at `https://<your-domain>/api/messages`, and add an OAuth connection
   named in `OAUTH_CONNECTION_NAME`.
3. **Oracle Cloud VM** — Ubuntu ARM in `ap-mumbai-1`, then Node, PM2, Nginx and
   a Let's Encrypt certificate. Graph will not post notifications to anything
   but public HTTPS.
4. **API keys** — Gemini from aistudio.google.com; Groq and Hugging Face are
   optional fallbacks. Without any key the bot uses the offline extractor, which
   is for development only and must not be used for real briefs.
5. **Teams transcription** — turn it on org-wide in the Teams Admin Center, or
   there is nothing to read.
6. **Teams app** — fill the `TODO_` values in `src/manifest/manifest.json`
   (see `src/manifest/README.md`), zip it with the two icons, and push it
   org-wide.

Then set `MOCK_MODE=false` and fill `.env`. Startup fails loudly if anything
required is missing.

### Verifying against the real thing

Hold two test meetings — one hosted by Dramantram, one by an external guest —
and confirm `meeting_logs.transcript_source` reads `application` for the first
and `delegated` for the second. That is the only way to prove both paths work.

## Layout

```
index.js                 Express + bot adapter + scheduled jobs
src/pipeline.js          meeting → filter → transcript → LLM → docx → Teams
src/config/adapters.js   the one place MOCK_MODE picks real vs. fixture
src/bot/                 Teams handler, SSO, proactive messaging, cards
src/graph/               MSAL auth, attendees, transcripts, subscriptions, VTT
src/filter/              the 3-step decision tree and the "was this a client?" card
src/llm/                 Gemini → Groq → Hugging Face, schema, offline extractor
src/docgen/              the template and the code that fills it
src/db/                  SQLite schema and CRUD
src/retention.js         deletes generated briefs after 30 days
fixtures/                meetings and transcripts for offline runs
scripts/                 E2E runner, template map builder
```

## Deliberately not built

- **A job queue.** `src/queue/worker.js` explains when BullMQ would earn its
  Redis instance. Meetings are processed inline; one process, no extra service.
- **The skip-learning layer.** `skipped_titles` counts declines already, but
  `shouldAutoSkip()` returns false — matching "Weekly sync - 12 Mar" against
  "Weekly sync - 19 Mar" needs a rule we have not agreed on.
- **The Resource Request Bot.** `src/resource-request/` and
  `src/routes/outlookAction.js` are placeholders for the other bot sharing
  this VM.
