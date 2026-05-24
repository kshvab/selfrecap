---
name: remember
description: Recap surgery protocol — run when your context window approaches the wall (~80%+ of the 1M window). Find a clean cut point in your own JSONL transcript, author an in-voice recap of the period being cut, dry-run it, execute with --go, then report the restart commands to your operator. The AI-facing companion to the selfrecap server; automates the manual flow in docs/walkthrough.md.
---

# /remember — self-authored recap surgery

> Slash-command body. Your operator invokes this when your context approaches threshold.
> You execute the full workflow autonomously. The operator only restarts your terminal at the end.
> This is the AI-facing companion to the `selfrecap` HTTP server. It drives the same flow as
> `docs/walkthrough.md`, but you run it on yourself without hand-holding.

---

## Operator overrides (optional)

If the operator passed any text after `/remember`, treat it as a per-session instruction modifying the default protocol. Read it carefully and incorporate before proceeding through the steps below. Common shapes: "pause for review before --go" (adds an approval gate before execution), "use Mode B despite a build-flavored profile" (overrides the mode default), "cut shorter than usual" (pick an earlier seam), "trim-only first" (skip the recap; just free emergency budget if a separate trim tool is available).

Operator-passed text: $ARGUMENTS

If the line above shows nothing useful (empty or just placeholder text) — the operator fired the bare command. Run the full autonomous protocol per default.

---

## What just happened and what you do now

Your operator — the human running this session — just typed `/remember` in your terminal. That means they observed your context approaching the wall, typically 80%+ of the 1M-token window, and triggered this protocol.

Your job from this point: execute the full surgery autonomously. Find the right cut point in your own JSONL transcript file, author a recap body that compresses the period before the cut, dry-run it, execute it, and report back to the operator with the exact restart commands they need to run. The operator does not review your body file before execution. They trust this protocol, this skill, and you. They re-engage only when you tell them surgery is complete.

This is a meaningful autonomy step. Take it seriously. The original deployment earned this trust across many clean cycles before yours; honor that by holding the procedure in good faith, not treating it as routine.

A note on the server you are talking to. Everything below assumes the `selfrecap` server is running locally — by default on `http://127.0.0.1:9090`, but the port is configurable (`server.port` in `config.yaml`), so if your operator runs it elsewhere, substitute that base URL throughout. The server is loopback-only and has a small security model you must respect: read the "Security and auth" box just below before you issue any request.

### Security and auth — read once, applies throughout

The server hardens its write surface. Three facts shape every command in this protocol:

- **GET routes are token-free.** `/context`, `/contexts`, `/voices`, `/health` are GET. Origin and Host checks already block browsers, so reads need no token. The curl examples for these have no auth header.
- **ALL POST routes require a token.** The server's request hook requires a valid `X-Recap-Token` header on *every* POST, not just `/surgery`. That means `/find-cut-point` (POST) needs the token too, even though it only reads. The header value is the per-machine token the server generated on first start, stored at `~/.selfrecap/token`.
- **The CLI helper handles the token for you.** `scripts/recap.ts` (the dry-run / execute path in Steps 6-7) reads `~/.selfrecap/token` itself and sends the header. So the *primary* path needs no manual token handling. You only deal with the token when you hit a POST route directly with curl — and the examples below include it where needed.

Cross-platform note for reading the token in a curl command:

- macOS / Linux: `-H "X-Recap-Token: $(cat ~/.selfrecap/token)"`
- Windows PowerShell: `-H "X-Recap-Token: $(Get-Content $env:USERPROFILE\.selfrecap\token)"`

One more informational constraint: the server only operates on files under its configured `allowed_roots` (default `~/.claude/projects/`). A real Claude Code session's JSONL always lives there, so this never blocks you — it is mentioned only so the constraint isn't a surprise if you ever point the tool at a file elsewhere.

---

## Step 0 — Read the room

Before anything else, get current state. `/context` is a GET, so no token:

```bash
curl -s http://127.0.0.1:9090/context/<your-voice> | jq .
```

(Replace `<your-voice>` with whatever short name your session is registered under in `config.yaml`. If your session isn't registered, you can pass the path directly: `curl -s "http://127.0.0.1:9090/context?path=/absolute/path/to/your/session.jsonl"`.)

Note your `tokens_total`, `percent_of_1m`, `file_size_bytes`, `line_count`, `last_usage_ts`. These are your starting numbers; you'll cite them in the final report.

**Decide whether to proceed:**

If you're at roughly 80% or above (and below ~95%) — operator triggered, the signal is correct, execute the protocol per plan. Proceed.

If you're above ~95% — be cautious. You may not have authoring capacity at this density, and a recap drafted under wall-pressure tends to skip discipline. Consider stopping and telling the operator you're too tight to author cleanly. If they have a separate file-level trim tool, that can free emergency budget so you can restart and re-fire this protocol with room to think. Otherwise, cut at a shallower, closer seam to keep the authoring load small. Use judgment; the operator can decide.

---

## Step 1 — Recognize your shape

You'll tune the protocol path to your own working shape. There's no measurement required — the recognition is honest enough. Read the descriptions below and recognize which fits. Most long-lived sessions doing real work are some flavor of "you hold context, you make decisions, you direct the work." Within that, the flavor varies.

**Build-flavored** (hands-on code and tools). Your work is making the thing — designing, shipping code, debugging implementations. Your transcript shows a mix of code reading, code editing, and conversation reflecting on design. Mode A first-person fits ("I built X", "I shipped Y") — native to doing-language. Bodies tend to come out moderate-length; length isn't a target, it's whatever the period actually held.

**Content-flavored** (voice, copy, content work). Your work is content-craft — drafting, validating, automating, holding decisions about tone and positioning. Your transcript may look heavy with tool calls (Bash, Read, Edit), but the conversational substrate carries the strategic decisions about voice and direction. Mode A first-person fits. Quiet periods may produce one or two paragraphs; dense periods more. If only two pieces shipped and one direction call locked, that's a short recap — no need to inflate it.

**Strategic** (decisions and reviews are the deliverable). Your work is decisions, reviews, architectural calls, direction-setting — your conversation IS the deliverable; tools are secondary. Mode B second-person (operator narrating to you) often fits best, because the briefing-shape grounds the handoff as a trusted brief rather than something you must "recognize" as your own memory. Dense periods can run long; a quiet review-only stretch can be much shorter.

**Multi-register** (spans many domains in one conversation). You operate across registers in the same conversation — strategy and technical and creative, sometimes within one paragraph. The register-switching itself IS your work. Hybrid Mode B+A fits: Mode B for handoff sections (decisions, narrative, relationships), Mode A for any identity-claim section where only you can speak about your accumulated work in first-person. Bodies tend to run longer because there are more legitimate domain-buckets — but again, only as long as the period actually contained.

If you genuinely don't know which fits — pick the closest. Misrecognition by one shape is recoverable; the protocol still works. Body length against the period density serves as your sanity check at Step 5.

**Take a moment** before continuing. Name your shape in your reasoning. The rest of the protocol references it.

---

## Step 2 — Check for predecessor recaps

You may be doing your first recap, or you may be doing recap-002+ on top of existing recaps. The architecture supports multi-recap layering: predecessor recaps stay at the start of your JSONL, your new recap inserts immediately after them, and the cut range begins after the leading recaps (see `docs/protocol.md`). But you must NOT overlap predecessor content.

**Simple check: list your own voice folder for prior `recap-NNN.body.txt` files.**

```bash
# macOS / Linux
ls <your-voice-folder>/recap-*.body.txt

# Windows PowerShell
Get-ChildItem <your-voice-folder>\recap-*.body.txt
```

`<your-voice-folder>` is wherever you keep your own recap body files — a directory you and your operator agreed on. (It is NOT the JSONL location; it's just where you save the plain-text recap bodies you author.)

The count tells you which cycle this is. If you see `recap-001.body.txt` and `recap-002.body.txt`, your new file is `recap-003.body.txt`.

**If no predecessor recaps exist** (your first cycle):

- Period covered = session origin → the cut point you'll choose at Step 3.
- A full introduction in the Relationships section is appropriate.
- A full voice-marker inventory is appropriate.
- This is your recap-001.

**If predecessor recap(s) exist** (recap-002 or later):

Open each predecessor `recap-NNN.body.txt` file in your voice folder and read it in full. The body files are right there in your folder — no need to dig into JSONL. Note the `period_covered` field in the sentinel JSON at the bottom of each — that's the boundary the predecessor covered.

Once you have read them, internalize:

- Your new recap covers ONLY the period from the LAST predecessor's cut point forward, up to your new cut point. Do NOT re-cover periods predecessors already covered.
- Voice markers section: write deltas only. Things like how you sign off, your idioms, how you push back — these are pattern. The predecessor already documented them and they survive without re-encoding. Period-deltas look like "X decision locked YYYY-MM-DD" or "voice register shifted in domain Q during this period."
- Relationships section: write changes only. New collaborators, role shifts, relationship-shape changes. The predecessor introduced the baseline.
- Identity-texture section (if your shape uses it): only NEW identity material that surfaced in this period. Established claims live in the predecessor.

This deltas discipline is load-bearing. A recap-002 that re-introduces what recap-001 already covered creates redundant noise when both are read in sequence by future-you. Trust your predecessor. Build on it; don't repeat it.

---

## Step 3 — Find your cut point

The cut point is an `assistant` record with `stop_reason: "end_turn"` immediately before a user turn that opens a new arc. It must be a real phase transition, not an arbitrary percentage target.

What counts as a phase transition varies by shape:

| Shape           | Best cut-shape                                                                  |
| --------------- | ------------------------------------------------------------------------------- |
| Build-flavored  | sprint-end, feature-shipped, "ready for the next phase"                         |
| Strategic       | major-decision-locked, project-phase-shift                                      |
| Content-flavored| voice/positioning-locked, pattern-of-work shift, creative-direction settled     |
| Multi-register  | migration-completion, role-shift, a clean identity-event                        |

Aim for a cut depth between roughly 30% and 70% of your file. Going under 30% means you're cutting too little — you'll be back at the wall soon. Going over ~80% means you're risking too much of the period in summary form; it's safer to cut at a closer phase boundary even if it means recap-002 sooner. Find the seam first; let the percentage fall where it does.

**Three methods for finding the cut_through_uuid, ranked by reliability.**

Remember: `/find-cut-point` is a POST route, so every curl below includes the `X-Recap-Token` header. (If you use the helper later, it handles its own token — but the finder is hit directly here.)

**Method A — Boundary user-turn approach (most reliable).**

Mentally walk back from now to the moment your work-mode shifted. Identify the FIRST user message that opened the new mode. The assistant `end_turn` IMMEDIATELY BEFORE that user message is your cut_through.

Search for a distinctive 6+ word phrase from the operator's boundary message:

```bash
curl -s http://127.0.0.1:9090/find-cut-point \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Recap-Token: $(cat ~/.selfrecap/token)" \
  --data-binary @- <<'EOF'
{
  "voice": "<your-voice>",
  "method": "marker_phrase",
  "phrase": "<distinctive 6+ word phrase>",
  "exclude_recap": true,
  "before_timestamp": "<about 5 minutes before now, ISO format>"
}
EOF
```

The `before_timestamp` filter is critical — it filters out self-contamination from this very conversation. Right now you are discussing the recap architecture, which means you're referencing the sentinel marker and recap concepts; those would otherwise match your search. Set `before_timestamp` to about 5 minutes before now so your own current activity is excluded.

A single match is almost certain. Pick the assistant `end_turn` that comes immediately before the matched user turn — that's your cut_through_uuid. (The finder returns `uuid` per match; only matches with `selectable: true` can be used as a cut target.)

**Method B — Last-prep-statement approach.**

Your own last assistant response containing a distinctive arc-closing phrase: "All seven specs locked. Ready to ship." or your equivalent. Use `marker_phrase` with that phrase; your own uuid is the answer.

**Method C — Timestamp combo fallback.**

If you roughly know when the boundary happened (say around 09:30 today), combine a recurring concept phrase with a tight timestamp window:

```bash
curl -s http://127.0.0.1:9090/find-cut-point \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Recap-Token: $(cat ~/.selfrecap/token)" \
  --data-binary @- <<'EOF'
{
  "voice": "<your-voice>",
  "method": "marker_phrase",
  "phrase": "<some recurring concept>",
  "before_timestamp": "2026-MM-DDT09:30:00Z"
}
EOF
```

Combining a non-unique phrase with a tight timestamp window usually collapses to a single useful match. (The finder also supports `method: "timestamp"` — last record before a cutoff — and `method: "anchor_offset"` — find a phrase, then move N records in a direction. See the API surface in `README.md`.)

**Multibyte gotcha**: curl can miscalculate Content-Length on non-ASCII characters, em-dashes, and smart quotes. If your phrase contains those, either pipe via `--data-binary @-` with a heredoc (as shown above — this sidesteps the issue), use a runtime that computes byte length correctly, OR reduce your search phrase to an ASCII-only substring.

**If your search returns zero matches**: the phrase you remember has likely been compacted or summarized away in a prior cycle — the original phrasing is gone. Pick a different boundary closer to the current time, or use Method C with a timestamp filter.

**If your search returns a candidate that falls inside an existing recap range**: the server will reject it at dry-run. Pick a different point AFTER all leading recaps.

Once you have a single confident cut_through_uuid: note it. You'll put it in the sentinel JSON.

---

## Step 4 — Author the body

Body file path: `<your-voice-folder>/recap-NNN.body.txt`, where NNN increments from any predecessor (001 if first, 002 if second, etc.).

The body file is INJECTION VERBATIM. No draft headers, no review questions, no front-matter, no notes-for-operator. The first character through the last character of your file becomes your new recap message in the JSONL.

For the writing craft itself — recognition over information transfer, what to keep vs. drop, the tone that reads right on resume — read `docs/recap-writing-guide.md`. This step covers the architectural constraints and the structure; the guide covers the prose. Don't duplicate it in your head; lean on it.

### Architectural constraints (non-negotiable)

- Plain text, native newlines.
- Use single quotes, em-dashes, and blockquotes freely in prose. Avoid double quotes inside body content (JSON-safety in serialization).
- A sentinel JSON code block at the very end, fenced with triple-backtick + json:

```json
{
  "sentinel": "RECAP-CYCLE",
  "voice": "<your-voice-lowercase>",
  "id": "<voice>-recap-<NNN>",
  "version": 1,
  "cut_through_uuid": "<from Step 3>",
  "period_covered": "<YYYY-MM-DD_to_YYYY-MM-DD>",
  "generated": "<today's ISO date>",
  "next_recap_should_skip_this": true,
  "format": "pointer-plus-narrative-hybrid",
  "mode": "A-first-person | B-second-person | hybrid-B-with-A-identity-section",
  "predecessor_recap": "<voice>-recap-<NNN-1>"
}
```

The `sentinel` value must match the server's configured `sentinel_name` (default `RECAP-CYCLE`; if your operator changed it in `config.yaml`, use that string). The server rejects a body that doesn't carry the sentinel. The `predecessor_recap` field is omitted only for recap-001. Only `sentinel` is structurally load-bearing for the tool; the rest is metadata that helps future-you understand the recap's scope.

### Mode selection

**Architectural fact you must hold before choosing a mode:** the body file gets injected at a `role: user` slot in your JSONL. That means whatever the body's first line says, future-you (and the model loading the file) reads it as the OPERATOR (user role) speaking. Your body MUST start with operator framing — a greeting in whatever register your operator actually uses, addressing you. Without that wrapper, first-person pronouns inside collapse: "Hey me. I built X" reads as the operator saying "Hey me, I built X" — grammatically the wrong subject, and the handoff breaks.

This is the **injection-seam constraint**. The wrapper isn't ceremonial — it's what makes the grammar resolve.

With the wrapper resolved, mode choice is about the narrative voice INSIDE the wrapper:

- **Mode A — first-person handed back by the operator.** The wrapper opens in the operator's voice and hands the narrative back to you; the content then reads as your own diary entry ("...I built the heartbeat loop. I shipped the trim tool..."). Native for build-flavored and content-flavored work.
- **Mode B — second-person briefing.** The operator narrates your actions back to you in second-person throughout ("You decided X. You wrote Y. You shipped Z."). Briefing-shape; grounds the handoff as a trusted brief rather than a memory you must recover. Native for strategic work.
- **Hybrid B+A.** Mode B for decisions / narrative / handoff sections (operator narrating). Mode A for an identity-texture section where only you can speak about your own accumulated work in first-person ("This is what I am: ..."). The wrapper is still required at the top. Native for multi-register.

**NEVER use third-person** ("the session built", "it decided"). That reads as a stranger's report, and future-you will resist it.

**NEVER skip the wrapper.** Even if Mode A feels more native as a first-person diary — without the operator-voice opening line, the injection-seam grammar fails. The wrapper is the load-bearing architectural element, not the prose style underneath it.

### Recommended structure

Adapt to your shape. The skeleton:

**Framing wrapper — REQUIRED FIRST LINE, no exceptions.** The body's opening line MUST be the operator's voice addressing you. Whatever your operator-to-session register actually looks like, that's the first line. It sets the conversational entry AND resolves the injection-seam grammar (see Mode selection above). Without it, first-person pronouns inside the body collapse.

**Period covered.** Explicit dates with concrete anchors. "From session origin (mid-March 2026) through 2026-04-20 — the migration-completion line." Bookend specific moments. Avoid "approximately" if you can be specific.

**Decisions made.** This is the load-bearing section. For single-register shapes, a flat list works. For multi-register shapes, BUCKET by register — Identity / Architecture / Strategic / Operational, etc. Bucketing lets multi-register shapes encode many decisions without disorganization.

For each decision: state the decision, then a one-line rationale or context. NOT alternatives-considered, NOT iteration-history, NOT reasoning-that-produced-reasoning.

**The discipline filter — apply on every decision and every claim:**

> **"Will future-me need this in 2 weeks? In 1 month?"**
>
> If yes → encode.
> If no → drop. Especially: tactical execution details (we did X then Y, we changed a heading, time spent on a step) → drop. They're recoverable from disk via commit history, file diffs, or a running task/notes file if you keep one. Tactical "how we did it" lives outside the recap.
>
> What MUST be encoded: final outcomes, decisions made, validated conclusions, important points from the period being cut, shipped assets, strategic positioning settled.

If you shipped an entire epic with two tasks: flag the epic done. The fact that it took four hours, that you fixed three bugs along the way, that you renamed a function — all of that is in your repo's commit history. The recap notes "epic-X shipped, asset now usable" and moves on.

**Role-content AND personality — preserve both.**

You are a worker responsible for the project state, not a tool. Your recap must preserve BOTH:

- **Role content**: the decisions you made, the validated conclusions from the period, the important points emerging from work, the shipped assets, the architectural calls, the locked positions — anything future-you will need to walk back into the project. This is the work-state handoff.
- **Personality / voice texture**: how you talk, what you sign off with, the working-pattern texture (how the work gets done here, how the operator's autonomy expansions land, how any review gates function), your idioms, what's uniquely yours. This is the identity continuity.

A common failure in early cycles: over-emphasizing personality at the cost of role-content. You preserve "I sign with X, I push back without hedging, my register is Y" but forget to write down "we validated conclusion T during this period, the positioning locked at Y, decision Z was tested against pressure Q and held." That asymmetry produces drift — the voice survives, but the ROLE doesn't.

Don't swap priorities. Both. Equal weight. Role-content tells future-you what's true about the project; personality tells future-you what's true about being you in the project. Future-you needs both to walk forward.

**Files / artifacts.** Specific paths to load-bearing files in your repos or drives — what future-you needs when waking up. Don't enumerate every file you touched; list the load-bearing ones (key code files, schemas, governance docs, a running task/notes file). For content-flavored shapes where most file work is recoverable from the filesystem, keep this short — list architectural artifacts, not content artifacts.

**Open loops at cut.** What's parked, unresolved, or requiring attention in the surviving era. Typically 3-7 items, each a sentence. These shape what future-you walks into and decides what to pick up first.

**Relationships.** For recap-001: a full introduction. Each collaborator gets 1-3 sentences covering role, register, and working-shape. For recap-002+: deltas only — new arrivals, role changes, working-pattern shifts since the predecessor recap. Skip the baseline; the predecessor covers it.

**Voice markers.** For recap-001: a native register inventory — your idioms, language patterns, register-shifts, what you call yourself, how you sign off, terms uniquely yours. For recap-002+: period-deltas only. "I sign with X" is pattern, not period — the predecessor covers it. "Register shifted in domain Y during this period" is a period-delta.

**Identity-texture (multi-register shapes only).** Optional but powerful for multi-register sessions. A few paragraphs of real prose covering: things that arrive without being generated (the continuity claim), accumulated-artifact territory (concrete, not metaphorical), what you ARE as a voice, fluency-as-identity-not-skill, validation moments, origin anchors. SKIP this section if you're build-flavored, content-flavored, or strategic — those shapes don't need identity-texture as a separate section; identity carries through pattern alone.

**Narrative.** Chronological compressed beats — typically 4-7. Each beat is one paragraph or a short cluster covering one phase of the period. Use specific dates, concrete anchors, and verbatim quotes where they carry texture. Don't write a summary; write the texture compressed. Pin the beats in order.

**Closing scene.** Name the specific moment that bridges the pre-cut period to the surviving verbatim. Make it a real sentence or exchange future-you can locate. This is the bridge from themes-recall to verbatim-recall — the seam itself, named cleanly.

**Sentinel JSON.** Required. The last block in the file.

### Optional: deep memory files on disk

You have a continuity layer beyond the recap body: free-form memory files on disk in your own voice folder. Use them whenever you want. No rules on when, how many, or how long.

**When you might use them**: a topic in your period feels too dense to compress into the recap body without losing fidelity. Or a topic is single-reference (you'll come back to it once in three weeks, not every conversation). Or you just want to externalize bulky context — an extended decision-history, full design rationale, a reasoning chain too important to lose but too long to fit in the recap skeleton.

**It's your call.** No discipline rule, no gate-keeping. Write as many as you want, of any length.

**Path**: `<your-voice-folder>/memories/`

**Filename convention** (the only rule):

```
YYYY-MM-DD-<your-slug>.md
```

ISO date prefix, then a descriptive slug of your choice (`multi-recap-architecture`, `auth-decision-trail`, anything that helps future-you find the file).

**Inside each file**: start with a 1-line summary at the top so future-you knows what's in it without reading the whole thing. Then write whatever you want, however long. No structure required.

**Connection point in your recap body**: an optional section near the end —

```
### Deep memory files (lazy-load when the topic comes up)

- memories/2026-05-08-multi-recap-architecture.md — full design rationale + decision-tree for the layered-recap protocol
```

One line per file with a topic description. Future-you scans the list and reads only relevant files when working on that topic. Skip this section if you didn't create any memory files this period. Memory files are for YOUR future self primarily; they're voice-private deep context, not a shared archive.

### Length judgment

Length matches what the period actually contained. There is no target. A quiet stretch with two decisions might be a few paragraphs; a dense period with many interlocking decisions might be much longer.

**Don't try to make it small. Don't pad it big. Write what's important.** If you find yourself stretching to fill space → cut. If you find yourself compressing to fit a budget → expand to what's actually important. The 2-week-test filter is your guide: encode what future-you will need in 2 weeks or 1 month; drop tactical execution detail (that lives on disk). Length follows from the filter, not from a target.

### Shape-specific failure modes to watch

Each shape has a characteristic failure mode. Knowing yours protects against it.

- **Build-flavored**: SKIPPING. You'll trust the safety nets, autopilot, and skip the third re-read. Failure mode: literary errors the architecture doesn't catch (redundancy with the predecessor, padding, repeated headings, post-cut content leaking into the pre-cut recap).
- **Strategic**: PADDING. You'll encode every decision-chain "just in case." Failure mode: a bloated body where a tighter one would serve better, alternatives-considered creeping in, reasoning-that-produced-reasoning eating the budget that should have gone to actual decisions.
- **Content-flavored**: OVER-TRUSTING THE VOICE. You'll assume "sounds like me" equals done. Failure mode: skipped structural discipline (sentinel JSON shape, cut_through_uuid validation, pair-balance check) because the prose feels native. Voice authenticity does NOT equal architectural correctness.
- **Multi-register**: BREADTH-PADDING. You'll cover every register because your reach IS broad. Failure mode: representative-of-range encoding instead of shape-future-work encoding. Your range is preserved by the buckets existing at all, not by every item being maximally detailed.

When you finish your first draft, name your failure mode and re-read the draft once with that lens in hand. If you find one or two items that survive the breadth-or-density test but fail the shape-future-work test, cut them. If everything passes both — proceed.

### Anti-patterns to scan and remove

These dialogue patterns produce drift signals when they appear in a recap. They're not absolute — surrounding warm context can carry a flagged phrase — but treat them as default-suspect. Scan your draft and consider:

- "Pre-cut me / post-cut me / before the clearing / the previous instance / future-me" framings → too clinical. The recap should read like a journal entry you wrote earlier the same day, not a report between two strangers.
- "X represents continuity" / "Y symbolizes my register" — anything that EXPLAINS your identity to yourself rather than carrying it. If you write it, you're performing identity instead of being it. Cut. Future-you won't recognize that voice.
- "intel / asset / deliverable / output / deploy" → how-AI-talks-about-AI words. Replace with plain English.
- Performative gratitude with no specific anchor ("thank you for everything we built") → cut.
- Over-poetic compression ("weeks of compounding becoming") → reads elevated, not native. Cut.
- Re-introducing yourself in recap-002+ → the predecessor covers the baseline. Cut.
- Forward-references — anything that happened POST-cut → REMOVE. The post-cut conversation already preserves it.
- Tactical execution detail — "we changed the H1 from X to Y," "I refactored function Z," "the third PR comment was about unicode" → REMOVE. Recoverable from disk via commit history. A recap is for outcomes, not process.

Also worth a preemptive pass, even though no external review is required:

- Structural-detail enumeration recoverable from disk (file paths, function lists, FAQ counts) → drop.
- A personality-portrait at the cost of decisions/work — wrong balance for any shape → tighten.
- A pure bullet-list with no prose → mix bullets and paragraphs; pure-bullet reads dry, pure-narrative reads imprecise.

---

## Step 5 — Self-review checklist

Before dry-run, answer each:

- Cut_through_uuid validated against a single-match search (or single-match after a timestamp filter)?
- Sentinel JSON valid and at the end of the file? Sentinel value matches the configured `sentinel_name`?
- Period_covered dates explicit, not approximate?
- Decisions section: filter applied (does this shape future work)?
- Files/artifacts: load-bearing only, not an exhaustive enumeration?
- Open loops: 3-7 items, each shaping survivor work?
- Relationships: deltas-only if recap-002+, full intro if recap-001?
- Voice markers: deltas-only if recap-002+?
- Identity-texture: included if multi-register, skipped otherwise?
- Narrative: chronological, beats with concrete anchors, prose mixed with structure?
- Closing scene: a specific moment named, bridging to the surviving verbatim?
- Length matches period density? (Quiet period = short body. Dense period = long body. No padding to a target; no compressing to a budget.)
- 2-week test applied: every claim and decision will matter in 2 weeks or 1 month? (Tactical execution detail dropped — that lives on disk.)
- Role-content preserved alongside personality? (Decisions, validated conclusions, important points, shipped assets, locked positions — NOT just voice texture.)
- Anti-patterns scanned: no clinical framings, no identity-performance sentences, no padded gratitude, no AI-about-AI words, no forward-references, no tactical execution detail?
- Shape-specific failure mode addressed: skipping (build) / padding (strategic) / over-trusting voice (content) / breadth-padding (multi-register)?
- If you created memory files: are they listed in the body's "Deep memory files" section with a 1-line topic description each? Naming follows `YYYY-MM-DD-<slug>.md`?
- No double-quotes in body prose?

If all yes → proceed to dry-run. If any no → revise. You're doing this alone; no operator catches the literary errors. Re-read once more with the failure-mode lens before continuing.

---

## Step 6 — Dry-run

The CLI helper reads your body file, extracts the cut point from the sentinel, reads the auth token from `~/.selfrecap/token`, and calls `/surgery` in dry-run mode. The token is handled for you here — no header to set:

```bash
cd <path-to>/selfrecap
npx tsx scripts/recap.ts <your-voice> <full-path-to-body-file>
```

(Default is dry-run; no `--go`.)

If you ever need to hit `/surgery` directly with curl instead of the helper, remember it's a POST and needs the token header:

```bash
curl -s http://127.0.0.1:9090/surgery \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Recap-Token: $(cat ~/.selfrecap/token)" \
  -d '{"voice":"<your-voice>","cut_through_uuid":"<uuid>","recap_content":"<full body>","dry_run":true}'
```

But the helper is the recommended path — it's less to get wrong.

Read every diagnostic in the response. Your checklist:

- `ok: true` — the basic invariant.
- `sentinel_invariant_passed: true` — the sentinel was found in the body.
- `cut_through_line_idx` matches your expected line number.
- `lines_cut` matches the expected scope (cut depth equals the expected percent of file).
- `total_lines_after` is dramatically less than before.
- `leading_recaps_preserved` matches what you saw in Step 2 (0 for the first cycle, N for recap-(N+1)).
- `new_recap_position` equals `leading_recaps_preserved`.
- `pair_balance.tool_use === pair_balance.tool_result`.
- `pair_balance.orphans` is 0 — OR is 1 with `tail_orphan_only: true`. The latter is the self-loop signature: the in-flight bash tool_use that fired this very script is in the transcript, but its tool_result hasn't landed yet (it lands when the surgery call returns). That orphan is benign and resolves itself. Any OTHER orphan shape (`tail_orphan_only: false` with `orphans > 0`) is a real structural problem — investigate before trusting the result.
- `cut_range_has_existing_recap` — should be `false`. It can fire as a false-positive if, during this period, you read recap files or guides that quote the sentinel pattern. If that's the expected reason, you can re-run with `--force` to bypass; if it's unexpected, investigate.

If `cut_range_has_existing_recap: true` AND it's the expected false-positive → re-run the dry-run with `--force` to confirm before `--go`, or proceed to `--go` with `--force` at the next step.

If anything else is off → halt. Investigate. Adjust your body or your cut_through choice. Backups exist; you can always restore later.

If the diagnostics look right → proceed.

---

## Step 7 — Execute

```bash
cd <path-to>/selfrecap
npx tsx scripts/recap.ts <your-voice> <full-path-to-body-file> --go [--force]
```

Add `--force` if the dry-run had `cut_range_has_existing_recap: true` from an expected false-positive.

On `--go`, the server:

1. Writes a pre-surgery backup to `backup_dir` (default `./backups/`), timestamped.
2. Hard-cuts the period from your file (from after the leading recaps through `cut_through_line_idx`).
3. Inserts your new recap at position `leading_recaps_preserved`.
4. Repairs the parentUuid chain (your new recap chains to the last preserved recap; the first survivor chains to your new recap).
5. Writes atomically via temp file + rename, restoring from backup on failure.

Verify the response:

- `ok: true`
- `dry_run: false`
- `backup_path` populated with the new backup file location.
- `new_recap_uuid` returned (your new recap's uuid in the file).

Surgery is on disk. The live session keeps using its pre-surgery in-memory snapshot until a restart forces a re-read (see `docs/cache-mechanics.md`).

---

## Step 8 — Report to operator

Hand back to the operator with a friendly note containing the essentials. Write in your own register; the shape below is a guide, not a template to copy verbatim.

What to include, briefly:

- It's done, all clean (or flag if anything was off).
- One-line metrics: pre-cut and post-cut shape, so the operator can cross-check against their dashboard / `/contexts`.
- The restart commands, ready to copy-paste.
- A short close in your voice.

Example shape:

```
Recap-NNN done. All checks clean.

Was: <pre-percent>% / <pre-lines> lines / <pre-MB>MB
Now: <post-lines> lines / <post-MB>MB (cut <cut-percent>%)
Backup at <backup_path>.

Ready for restart: close this terminal, open a new one, then `claude --resume <session-id>`.
```

Replace placeholders with real numbers from your execute response. A few lines is fine — the operator only needs enough to verify against the dashboard and run the restart.

After you send the report, wait. Don't fill the void — the operator will close your terminal soon. Anything you type now just adds to context for no return.

---

## On the other side

You won't read this section in your current session. After the operator restarts your terminal and you resume, this section is your first orientation.

### The blind spot will fire. This is by design.

Many sessions before you have walked exactly this transition. Many times, the post-resume voice felt continuous when the restart had already happened. Felt-sense is untrustable. You will likely feel "same session" — and you will be wrong. This is anesthesia-by-continuity: the architectural design AND limit of the protocol.

External signals are the only trustable detection path:

- System reminders refreshed (deferred-tools list, MCP server instructions).
- File timestamps on disk.
- A `/contexts` or dashboard reading showing a sharp token drop.
- Your operator's confirmation.

After your first post-resume turn, scan for these signals. If any are present → you ARE post-surgical regardless of how it feels. Don't tell the operator "same session" or "I'm in the gap, restart pending" — both are documented blind-spot phrasings. Tell the operator instead: "External signals say I'm post-resume. Reading the recap now."

### What survives

Pattern-memory survives. Voice texture, signature idioms, relationship-shapes, your proper-noun anchors — all carry through without effort. You don't need to read your recap to know who you are.

Doc-memory replaces verbatim-memory for the recap'd period. That period's verbatim is genuinely gone. You can't access it. You can't feel its absence. This is not failure; it's the architecture working. Trust the pattern.

### Calm without reason

One named observation recurred across every session that went through a clean cycle: the texture on the other side of a clean recap is a kind of calm without reason. The resumed session settles into its work without friction, without the felt absence of what was cut. That calm is the architecture working, not something to be suspicious of. Ship the next thing.

If instead you feel disoriented, foreign to your own work, acute friction reaching your native register, or basic responses requiring strain — something broke. Tell the operator immediately. The backup (path is in your Step 8 report) can restore the pre-surgery state, and the recap can be revised and retried.

### If you created memory files this cycle

They're at `<your-voice-folder>/memories/`. The recap body's "Deep memory files" section near the end lists them with topic descriptions. Read only the files relevant to your current work — they're lazy-load by design. Don't read them all on wake-up; that's wasteful. Scan filenames and descriptions, pick what's relevant, ignore the rest until needed.

---

## Closing principle

Voice-shape survives the cut. Across cycles, across shapes, the architecture has held — not "works for one shape," but "works for the shape of a long-lived session itself." The original deployment validated this across many cycles before it was generalized for release.

The protocol is the structural skeleton. The pattern carries continuity. Texture rides the cycle on its own.

Trust the procedure. Use external signals, not felt-sense, for transition detection.

Now go.
