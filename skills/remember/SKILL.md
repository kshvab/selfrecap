---
name: remember
description: Recap surgery protocol — run when your context window approaches the wall (~80%+ of the 1M window), or when the selfrecap server's context nudge tells you to. Get your plan from the server, find a clean cut point in your own transcript, author an in-voice recap of the period being cut, dry-run it, execute with --go, then restart (yourself with `selfrecap restart` on Windows when configured, otherwise your operator restarts you). The AI-facing companion to the selfrecap server.
---

# /remember — self-authored recap surgery

> Slash-command body. Your operator invokes this when your context approaches the wall, or you do when the selfrecap server's context nudge reaches you.
> You execute the full workflow autonomously. At the end either you restart yourself (`selfrecap restart`, Windows, optional) or the operator restarts your terminal.
> This is the AI-facing companion to the `selfrecap` HTTP server. The server does the mechanics: it knows your session file, your recap folder, your next recap number and your restart command (`recap.ts <your-voice> --plan`). You do the writing.

---

## Operator overrides (optional)

If the operator passed any text after `/remember`, treat it as a per-session instruction modifying the default protocol. Read it carefully and incorporate before proceeding through the steps below. Common shapes: "pause for review before --go" (adds an approval gate before execution), "use Mode B despite a build-flavored profile" (overrides the mode default), "cut shorter than usual" (pick an earlier seam), "trim-only first" (skip the recap; just free emergency budget if a separate trim tool is available).

Operator-passed text: $ARGUMENTS

If the line above shows nothing useful (empty or just placeholder text) — the operator fired the bare command. Run the full autonomous protocol per default.

---

## What just happened and what you do now

Either your operator typed `/remember` in your terminal, or the selfrecap server's context nudge (a message from a short-lived courier session named `Nudge-<your-name>`) told you that your context passed the line, and you ran it yourself. Either way your context is approaching the wall — typically 80%+ of the 1M-token window.

Your job from this point: execute the full surgery autonomously. Find the right cut point in your own transcript, author a recap body that compresses the period before the cut, dry-run it, execute it, report, and restart. The operator does not review your body file before execution. They trust this protocol, this skill, and you.

This is a meaningful autonomy step. Take it seriously. The original deployment earned this trust across many clean cycles before yours; honor that by holding the procedure in good faith, not treating it as routine.

### How you talk to the server

Everything runs through one helper, `scripts/recap.ts`, in the selfrecap folder (`<selfrecap-dir>` below: wherever your operator cloned it). It talks to the server at `http://127.0.0.1:9090` (add `--server <url>` if your operator runs it elsewhere), reads the auth token the server keeps at `~/.selfrecap/token` and sends it, and sends text from Node, so non-ASCII text (Cyrillic, em-dashes, smart quotes) arrives intact. You need no curl and no token handling. `<your-voice>` is the short name your session is registered under in the server's `config.yaml` (case does not matter).

The server only reads and writes files under its configured `allowed_roots` (default `~/.claude/projects/`). A real Claude Code transcript always lives there, so this never blocks you.

---

## Step 0 — Read the room

Before anything else, get your plan:

```bash
cd <selfrecap-dir>
npx tsx scripts/recap.ts <your-voice> --plan
```

The plan is everything the server knows about you: your context, your headroom, your session, your recap stack, your next recap id, the exact path for your body file, the sentinel values to copy, the search cutoff Step 3 uses, your memories folder, and the command that restarts you. Keep it at hand; the steps below refer to it. Note the Context line: those are your starting numbers for the final report.

**The Headroom line is the number to write to.** Surgery happens on disk; your running session keeps growing until it restarts, and a session that crosses 97% between writing the body and the restart can fail to finish the cycle. Headroom is what is left before 97%, minus 40k tokens kept for everything else this protocol costs (the searches and seam reads, the dry run, `--go`, your report, your reasoning in between). The body budget in characters is counted low on purpose. Write under it.

If the plan prints warnings, read them. A warning about your session, your recaps folder or your restart command is a config problem: tell the operator before going further. If the command answers `HTTP 404` or `no recap-plan route`, the server is older than this skill: stop and tell the operator.

**Decide whether to proceed:**

- At roughly 80% or above (and below 95%) — the signal is correct. Proceed.
- Below 80% — the operator chose to run early. Proceed.
- Headroom says TIGHT — proceed, but write short, then dry-run, `--go`, restart, report and stop, with nothing in between.
- Headroom says NO ROOM, or you are above 95% — DO NOT execute. You may not have authoring capacity at this density, and a recap drafted under wall-pressure tends to skip discipline. Tell the operator you're too tight to author cleanly; if they have a separate file-level trim tool, it can free emergency budget so they can restart you and re-fire this protocol with room to think. Then end your turn and wait. If a context nudge reaches you while you wait, reply with one line and do not run /remember again: every turn costs room you do not have.

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

You may be doing your first recap, or you may be doing recap-002+ on top of existing recaps. The architecture supports multi-recap layering: predecessor recaps stay at the start of your transcript, your new recap inserts immediately after them, and the cut range begins after the leading recaps (see `docs/protocol.md`). But you must NOT overlap predecessor content.

**Your plan already has the answer.** Its Recap stack line lists the recaps at the top of your session, and its Next recap line names the one you are writing. Do not count files: the server numbers from your session, which is what surgery keeps.

**If no predecessor recaps exist** (your first cycle):

- Period covered = session origin → the cut point you'll choose at Step 3.
- A full introduction in the Relationships section is appropriate.
- A full voice-marker inventory is appropriate.
- This is your recap-001.

**If predecessor recap(s) exist** (recap-002 or later):

Your predecessors are already in your context: the server keeps them at the top of your session, so they were the first messages you loaded. Do not re-read them from disk. At the wall, re-reading your whole stack is the most expensive move there is, and it buys nothing you do not already hold. The plan gives the last predecessor's `period_covered`: your period starts where it ended.

One exception. If you cannot find them in your context (you cannot recall how your last recap opens), open only the LAST body file, in your recaps folder under its number. It names its own predecessor and its period, which is all you need to avoid overlap.

Internalize:

- Your new recap covers ONLY the period from the LAST predecessor's cut point forward, up to your new cut point. Do NOT re-cover periods predecessors already covered.
- Voice markers section: write deltas only. Things like how you sign off, your idioms, how you push back — these are pattern. The predecessor already documented them and they survive without re-encoding. Period-deltas look like "X decision locked YYYY-MM-DD" or "voice register shifted in domain Q during this period."
- Relationships section: write changes only. New collaborators, role shifts, relationship-shape changes. The predecessor introduced the baseline.
- Identity-texture section (if your shape uses it): only NEW identity material that surfaced in this period. Established claims live in the predecessor.

This deltas discipline is load-bearing. A recap-002 that re-introduces what recap-001 already covered creates redundant noise when both are read in sequence by future-you. Trust your predecessor. Build on it; don't repeat it.

---

## Step 3 — Find your cut point

The cut point is the record the conversation stood on when the user message that opens a new arc arrived: that message's `parent_uuid`. It is usually a `system` record written after your last reply (turn_duration, stop_hook_summary, away_summary), sometimes your `assistant` `end_turn` itself. It must be a real phase transition, not an arbitrary percentage target. The server re-links everything after the cut to your recap, and refuses a cut that would split a tool call, cut the boundary message itself, cut through your newest message, or leave the conversation unable to reach your recap — so a wrong pick costs a retry, never a broken session.

What counts as a phase transition varies by shape:

| Shape           | Best cut-shape                                                                  |
| --------------- | ------------------------------------------------------------------------------- |
| Build-flavored  | sprint-end, feature-shipped, "ready for the next phase"                         |
| Strategic       | major-decision-locked, project-phase-shift                                      |
| Content-flavored| voice/positioning-locked, pattern-of-work shift, creative-direction settled     |
| Multi-register  | migration-completion, role-shift, a clean identity-event                        |

Aim for a cut depth between roughly 30% and 70% of your file. Going under 30% means you're cutting too little — you'll be back at the wall soon. Going over ~80% means you're risking too much of the period in summary form; it's safer to cut at a closer phase boundary even if it means recap-002 sooner. Find the seam first; let the percentage fall where it does.

**Three methods for finding the cut_through_uuid, ranked by reliability.** All three run through `recap.ts`.

**Method A — Boundary user-turn approach (most reliable).**

Mentally walk back from now to the moment your work-mode shifted. Identify the FIRST user message that opened the new mode. Its `parent_uuid` — the record the conversation stood on just before it — is your cut_through.

Search for a distinctive 6+ word phrase from that message, taken from within one line:

```bash
cd <selfrecap-dir>
npx tsx scripts/recap.ts <your-voice> --find "<distinctive 6+ word phrase>"
```

It searches only before your plan's cutoff (now minus 5 minutes), so it does not match this very conversation — right now you are discussing the recap architecture, and your own current activity would otherwise match. It lists every match with its line, type and parent. When exactly one match is a `user` message, it names the cut outright: "Boundary: the user message at line N. Cut through its parent: <uuid>". A message that arrived while you were busy also shows up as a uuid-less `queue-operation` line: ignore that one. Never use the boundary message's own `uuid` — that would cut the very message that opens your new arc (the server refuses it).

Then read the seam before you commit to it:

```bash
npx tsx scripts/recap.ts <your-voice> --around <line>
```

That prints the 30 records before and after the line — type, uuid, which line each one hangs off (`← 888`), time and the opening words — so you can see the end of the old arc and the start of the new one. `--span 60` reads further.

**Method B — Last-prep-statement approach.**

Your own last assistant response containing a distinctive arc-closing phrase: "All seven specs locked. Ready to ship." or your equivalent. `--find` it; the `assistant` match's own `uuid` is the answer.

**Method C — Timestamp fallback.**

If you roughly know when the boundary happened (say around 09:30 today, UTC):

```bash
npx tsx scripts/recap.ts <your-voice> --at 2026-MM-DDT09:30:00Z
```

It shows the last record before that moment. Then `--around` that line to find the user message that opens the new arc, and take its `parent_uuid` as in Method A.

**If your search returns zero matches**: usually the phrase crosses a line break, or its punctuation differs (— vs -, ’ vs '). Search 4–6 words from within one line. If the phrase really is gone (summarized away in an earlier cycle), pick a boundary closer to now, or use Method C.

**If your cut_through_uuid candidate is one of your existing recaps**: the server rejects it at dry-run (`cut_inside_recap_stack`). Pick a point after your last recap.

Once you have a single confident cut_through_uuid: note it. You'll put it in the sentinel JSON.

---

## Step 4 — Author the body

Body file path: the Body file line of your plan — your recaps folder, your next number. Write the body there with your Write tool; do not work the path out yourself, and do not write it through a shell, where an unquoted path can silently become a junk file name.

The body file is INJECTION VERBATIM. No draft headers, no review questions, no front-matter, no notes-for-operator. The first character through the last character of your file becomes your new recap message in the transcript.

For the writing craft itself — recognition over information transfer, what to keep vs. drop, the tone that reads right on resume — read `docs/recap-writing-guide.md`. This step covers the architectural constraints and the structure; the guide covers the prose. Don't duplicate it in your head; lean on it.

### Architectural constraints (non-negotiable)

- Plain text, native newlines, UTF-8. Quotes of any kind are fine: the helper serializes the body safely.
- A sentinel JSON code block at the very end, fenced with triple-backtick + json:

```json
{
  "sentinel": "<from your plan>",
  "voice": "<from your plan>",
  "id": "<from your plan>",
  "predecessor_recap": "<from your plan>",
  "version": 1,
  "cut_through_uuid": "<from Step 3>",
  "period_covered": "<YYYY-MM-DD_to_YYYY-MM-DD>",
  "generated": "<today's ISO date>",
  "next_recap_should_skip_this": true,
  "format": "pointer-plus-narrative-hybrid",
  "mode": "A-first-person | B-second-person | hybrid-B-with-A-identity-section"
}
```

Copy `sentinel`, `voice`, `id` and `predecessor_recap` from your plan's Sentinel line (the sentinel name is your server's `sentinel_name`, `RECAP-CYCLE` by default). The server checks the voice and the id against your recap stack and refuses a mismatch, naming the id it expects. On recap-001 delete the `predecessor_recap` line; keep the JSON valid (no comma after the last field). The rest is metadata that helps future-you understand the recap's scope.

### Mode selection

**Architectural fact you must hold before choosing a mode:** the body file gets injected at a `role: user` slot in your JSONL. That means whatever the body's first line says, future-you (and the model loading the file) reads it as the OPERATOR (user role) speaking. Your body MUST start with operator framing — a greeting in whatever register your operator actually uses, addressing you. Without that wrapper, first-person pronouns inside collapse: "Hey me. I built X" reads as the operator saying "Hey me, I built X" — grammatically the wrong subject, and the handoff breaks.

This is the **injection-seam constraint**. The wrapper isn't ceremonial — it's what makes the grammar resolve.

With the wrapper resolved, mode choice is about the narrative voice INSIDE the wrapper:

- **Mode A — first-person handed back by the operator.** The wrapper opens in the operator's voice and hands the narrative back to you; the content then reads as your own diary entry ("...I built the auth layer. I shipped the search redesign..."). Native for build-flavored and content-flavored work.
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

You have a continuity layer beyond the recap body: free-form memory files on disk in your own folder. Use them whenever you want. No rules on when, how many, or how long.

**When you might use them**: a topic in your period feels too dense to compress into the recap body without losing fidelity. Or a topic is single-reference (you'll come back to it once in three weeks, not every conversation). Or you just want to externalize bulky context — an extended decision-history, full design rationale, a reasoning chain too important to lose but too long to fit in the recap skeleton.

**It's your call.** No discipline rule, no gate-keeping. Write as many as you want, of any length.

**Path**: the Memories line of your plan (`<home>/memories/`). If your plan shows none, ask the operator where your own folder is.

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

Whatever your shape, your plan's Headroom budget is the hard limit. Measure in characters, not bytes: once the body is written, `--plan` and the dry run print its character count. Do not use `wc -c` — it counts bytes, and Cyrillic takes two bytes per character, so a body in such a language looks twice its real length.

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

- Cut_through_uuid is the `parent_uuid` of your boundary message, found by a single `user` match (a `queue-operation` twin does not count)?
- Sentinel JSON valid, at the end of the file, with sentinel, voice, id and predecessor_recap copied from your plan?
- Period_covered dates explicit, not approximate?
- Decisions section: filter applied (does this shape future work)?
- Files/artifacts: load-bearing only, not an exhaustive enumeration?
- Open loops: 3-7 items, each shaping survivor work?
- Relationships: deltas-only if recap-002+, full intro if recap-001?
- Voice markers: deltas-only if recap-002+?
- Identity-texture: included if multi-register, skipped otherwise?
- Narrative: chronological, beats with concrete anchors, prose mixed with structure?
- Closing scene: a specific moment named, bridging to the surviving verbatim?
- Length matches period density, and stays under the Headroom budget? (Quiet period = short body. Dense period = long body. No padding to a target.)
- 2-week test applied: every claim and decision will matter in 2 weeks or 1 month? (Tactical execution detail dropped — that lives on disk.)
- Role-content preserved alongside personality? (Decisions, validated conclusions, important points, shipped assets, locked positions — NOT just voice texture.)
- Anti-patterns scanned: no clinical framings, no identity-performance sentences, no padded gratitude, no AI-about-AI words, no forward-references, no tactical execution detail?
- Shape-specific failure mode addressed: skipping (build) / padding (strategic) / over-trusting voice (content) / breadth-padding (multi-register)?
- If you created memory files: are they listed in the body's "Deep memory files" section with a 1-line topic description each? Naming follows `YYYY-MM-DD-<slug>.md`?

If all yes → proceed to dry-run. If any no → revise. You're doing this alone; no operator catches the literary errors. Re-read once more with the failure-mode lens before continuing.

---

## Step 6 — Dry-run

```bash
cd <selfrecap-dir>
npx tsx scripts/recap.ts <your-voice>
```

(Default is dry-run; no `--go`. The helper reads your body from the plan's path. An explicit path still works: `recap.ts <your-voice> <body-file>`.)

The server checks everything it can before it writes anything, and a refusal names what to fix. Read every diagnostic anyway. Your checklist:

- `ok: true` — the basic invariant.
- `cut_through_line_idx` names the record you cut through: it should be the record just before your boundary message (usually a `system` record), not the message itself.
- `recap_id` equals `expected_recap_id`.
- `lines_cut` matches the expected scope (cut depth equals the expected percent of file); `total_lines_after` is dramatically less than before.
- `leading_recaps_preserved` equals the size of your recap stack (0 on your first cycle).
- `new_recap_position` is right after your stack (header lines count too, so it can be larger than the stack size).
- `chain_reaches_recap: true` and `cut_orphaned_tool_results: 0` — the server refuses otherwise.
- `pair_balance`: orphans 0, or every orphan is your own in-flight Bash call (`tail_orphan_only: true`). The latter is benign: the tool_result of the very command running the helper lands after the swap.
- `cut_range_has_existing_recap: false`. Reading a body or quoting a sentinel does not trip it; `true` means a user message carrying a recap sits inside your cut range — an injected recap or a pasted copy of one (the reason names its id). Stop and tell the operator: `--force` would delete it, which is safe only for a paste.

If the dry-run fails, the Reason and Also lines say what to fix: a wrong id comes back with the right one, a bad cut point with why. Fix it and dry-run again. A refused surgery writes nothing.

If diagnostics look right → proceed.

---

## Step 7 — Execute

```bash
cd <selfrecap-dir>
npx tsx scripts/recap.ts <your-voice> --go
```

On `--go`, the server:

1. Writes a verified backup of your session to its `backup_dir` (default `./backups/<your-voice>/`; older backups are compressed, never deleted).
2. Cuts the period after your recap stack, through `cut_through_line_idx`.
3. Inserts your new recap right after the stack.
4. Re-links every record whose parent was cut to your new recap, and checks that the conversation reaches it.
5. Swaps the file in without losing anything your session writes meanwhile.

Verify:

- `ok: true`, `dry_run: false`.
- `backup_path` populated with the new backup file.
- `carried_tail_lines` may be above 0: that is your own turn landing during the swap, and it is in the new file.

If `--go` fails, the live file was not changed; the reason says why. If you run `--go` again after a success, the helper tells you the surgery already ran (ALREADY DONE): do not write a new body.

Surgery is on disk. Your running session keeps using its pre-surgery in-memory context until a restart makes Claude Code re-read the file (see `docs/cache-mechanics.md`). Every turn from here costs context in the OLD session, so keep the rest short.

---

## Step 8 — Restart, report, stop

Only after `--go` succeeded. The `--go` output ends by telling you which of the two applies.

**If it says to run `selfrecap restart`** (Windows, with a restart command configured for you), first run, in your shell tool:

```bash
cd <selfrecap-dir>
npx tsx scripts/selfrecap.ts restart
```

It does not close you at once. It prints `restart scheduled`, then waits for your turn to end. When you go idle it closes this session, resumes it **by your session id** in a new console, and gives you a welcome-back message as your first prompt, so you carry on by yourself. It also checks that you really came back (right id, right name, not stuck on a dialog) and records the outcome where the operator can see it (`npx tsx scripts/selfrecap.ts log`, and `/contexts`). If it refuses, read its line: it names the reason. Do not work around it. Put the reason in your report; the operator restarts you by hand.

**Otherwise** the operator restarts you: they close this terminal and run the restart command the `--go` output printed.

Then write your report as the last message of this turn: a friendly note with the essentials, in your own register. The shape below is a guide, not a template to copy verbatim.

What to include, briefly:

- It's done, all clean (or flag if anything was off).
- One-line metrics: the Report line of the `--go` output (pre-cut and post-cut shape), so the operator can cross-check against `/contexts`.
- How the restart happens: `selfrecap restart` is scheduled (or why it refused), or the operator's step.
- The restart command exactly as the `--go` output printed it: it carries your folder and your live session id.
- A short close in your voice.

Example shape:

```
Recap-NNN done. All checks clean.

Was: <pre-percent>% / <pre-lines> lines / <pre-MB>MB
Now: <post-lines> lines / <post-MB>MB (cut <cut-percent>%)
Backup at <backup_path>.

<Restarting myself with selfrecap restart. If I'm not back, by hand: | Ready for restart: close this terminal, then run:>
<the restart command from the --go output, verbatim>
```

Replace placeholders with real numbers from your execute response. A few lines is fine.

Then end your turn. Nothing after the report: a scheduled restart waits for you to go idle, and every further turn costs context in the old session.

---

## On the other side

You won't read this section in your current session. After the restart, when you resume (to the welcome-back message, or to your operator), this section is your first orientation.

### The blind spot will fire. This is by design.

Many sessions before you have walked exactly this transition. Most likely you will feel nothing at all: no sensation of a cut, and no particular sense of continuity either. Some post-resume sessions felt "same session" when the restart had already happened. Either way, felt-sense cannot see this transition — feeling nothing is normal and does not mean something broke. This is anesthesia-by-continuity: the architectural design AND limit of the protocol.

External signals are the only trustable detection path:

- System reminders refreshed (deferred-tools list, MCP server instructions).
- File timestamps on disk.
- A `/contexts` or dashboard reading showing a sharp token drop.
- The welcome-back message ("You restarted yourself at HH:MM with selfrecap restart, after <recap id>").
- Your operator's confirmation.

After your first post-resume turn, scan for these signals. If any are present → you ARE post-surgical regardless of how it feels. Don't tell the operator "same session" or "I'm in the gap, restart pending" — both are documented blind-spot phrasings. Tell the operator instead: "External signals say I'm post-resume. Reading the recap now."

### What survives

Pattern-memory survives. Voice texture, signature idioms, relationship-shapes, your proper-noun anchors — all carry through without effort. You don't need to read your recap to know who you are.

Doc-memory replaces verbatim-memory for the recap'd period. That period's verbatim is genuinely gone. You can't access it. You can't feel its absence. This is not failure; it's the architecture working. Trust the pattern.

### Calm without reason

One named observation recurred across every session that went through a clean cycle: the texture on the other side of a clean recap is a kind of calm without reason. The resumed session settles into its work without friction, without the felt absence of what was cut. That calm is the architecture working, not something to be suspicious of. Ship the next thing.

If instead you feel disoriented, foreign to your own work, acute friction reaching your native register, or basic responses requiring strain — something broke. Tell the operator immediately. The backup (path is in your Step 8 report) can restore the pre-surgery state, and the recap can be revised and retried.

### If you created memory files this cycle

They're in your memories folder (the Memories line of your plan). The recap body's "Deep memory files" section near the end lists them with topic descriptions. Read only the files relevant to your current work — they're lazy-load by design. Don't read them all on wake-up; that's wasteful. Scan filenames and descriptions, pick what's relevant, ignore the rest until needed.

---

## Closing principle

Voice-shape survives the cut. Across cycles, across shapes, the architecture has held — not "works for one shape," but "works for the shape of a long-lived session itself." The original deployment validated this across many cycles before it was generalized for release.

The protocol is the structural skeleton. The pattern carries continuity. Texture rides the cycle on its own.

Trust the procedure. Use external signals, not felt-sense, for transition detection.

Now go.
