# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-10-15

Field-tested improvements from the original deployment, ported in: surgery that
is safe to run from inside the live session and cannot strand a resumed
session, the recap plan, session continuation, a fuller `/contexts`, and an
updated `/remember` skill. Optional, Windows-only, off by default: a context
nudger and `selfrecap restart`.

### Added

- **`GET /voices/:voice/recap-plan`** — everything a session needs for
  `/remember`: context and headroom (the body budget in characters), the recap
  stack, the next recap number, id and body path, the sentinel values, a
  `suggested_before_timestamp`, the restart command with the live session id.
- **`GET /voices/:voice/records?around=&span=`** — the records around a line,
  for reading a seam before choosing the cut.
- **Session continuation** — a voice's session follows Claude Code's
  `continued-in` markers to the live file, for readings, the plan and surgery.
  `/voices`, `/context/:voice` and `/contexts` report the hops; a broken link is
  reported and surgery refuses the frozen ancestor.
- **`/contexts`** — per voice: continuation info, the recap stack, headroom, a
  `stale_reading` flag, liveness (Windows) and the last nudge/restart event.
- **Plan-usage bars** (`usage.enabled`, off by default) — `/contexts`
  `account_usage`, read with each account's own login token from an
  undocumented Anthropic endpoint. See the README before turning it on.
- **`scripts/recap.ts`** — `--plan`, `--find`, `--around`, `--at`; the body
  defaults to the plan's path; requests go out from Node (no curl), so
  non-ASCII text arrives intact; a repeated `--go` answers ALREADY DONE; the
  diagnostics print as a checklist (`--json` for the full response).
- **Context nudger** (`nudge.enabled`, off by default, Windows only) — a live
  session past `nudge.at` percent is told to recap and restart.
- **`selfrecap restart`** (`scripts/selfrecap.ts`, Windows only, optional) — a
  session restarts itself after its recap: waits for its turn to end, closes
  it, resumes the same id in a new console with a welcome-back prompt, checks
  it came back, records the outcome (`selfrecap log`).
- **`npm run check-config`** and **`npm run install-skill`**.
- New config keys: per voice `recaps`, `home`, `restart`, `name` (and
  `session`, with `path` still accepted); top-level `accounts`, `nudge`,
  `usage`. `config.yaml` problems are reported per entry instead of failing.

### Changed

- **Surgery re-parents by chain.** Every survivor whose parent was cut now
  points at the new recap (before, only the next line was re-pointed; when that
  line was a metadata record the resumed session never reached its recaps), and
  the server checks that the chain from the newest message reaches the recap.
- **Surgery refuses more cuts that would hurt the session**: one that splits a
  tool call from its surviving result (`cut_splits_tool_call`), one through a
  user message whose reply survives (`cut_is_user_message`), one that leaves
  the chain broken (`chain_broken`), a sentinel whose id is not the next in the
  voice's stack (`sentinel_id_mismatch`) or whose voice is another
  (`sentinel_voice_mismatch`). An unparseable first survivor is now refused as
  `chain_broken` (was `first_survivor_unparseable`).
- **Header records** (uuid-less metadata Claude Code writes at the top of a
  file) are kept in place and skipped before the recap stack.
- **Recaps are recognized structurally**: a user message whose string content
  carries a sentinel that parses. Text that only quotes the sentinel (a tool
  result, assistant text, a task notification) no longer counts, so
  `cut_range_has_existing_recap` no longer fires on routine work. Recaps
  written without an `id` are still recognized.
- **The swap is safe under a live session**: lines appended during surgery are
  carried into the new file; a half-written line is waited out; the rename is
  retried while another process holds the file; a file that shrank or changed
  before the read point stops the surgery (409, nothing changed). This
  replaces 1.0's in-process lock and mtime abort. The live file is never
  restored from the older backup after a failed write.
- **Backups** are verified (fsync + read-back), kept per voice in
  `backup_dir/<voice>/`, the newest three raw and older ones gzipped.
- The injected recap copies `permissionMode` and `gitBranch` from the
  conversation when present and leaves them out otherwise (1.0 refused a
  session without `gitBranch`).
- `/find-cut-point` with `exclude_recap` skips injected recap records only.
- The `/remember` skill drives the cycle from the plan and ends with
  `selfrecap restart` where configured, else the operator's restart.

### Compatibility

- Existing `config.yaml` files load unchanged. Voice names are now
  case-insensitive and reported lower-case.
- Existing recaps keep matching: `sentinel_name` works as before, and recaps
  without ids are still recognized and protected.
- Passing both `voice` and `file_path` is now a 400 (it was ambiguous).
- `/surgery` returns 409 for a swap that could not be finished and 500 for a
  failed backup; refusals stay 400.

## [1.0.0] - 2026-05-25

First public release. An HTTP API for Claude Code session continuity: find clean
cut points in JSONL transcripts, monitor context-window size, and perform
self-authored recap surgery as an alternative to lossy auto-compaction.

### Added

- **`POST /find-cut-point`** — locate a record in a session by `marker_phrase`,
  `timestamp`, or `anchor_offset`, returning each match's `uuid` plus a
  surrounding context window. Supports `exclude_recap`, `limit` (default 50,
  max 500), and a `before_timestamp` self-contamination filter.
- **`GET /context/:voice`** and **`GET /context?path=...`** — current
  context-window size, computed the way Claude Code's own `/context` does
  (last non-sidechain `assistant.usage`, summing input + cache-read +
  cache-creation tokens).
- **`GET /contexts`** — single-call snapshot of every configured voice, with
  per-voice error isolation.
- **`POST /surgery`** — cut + inject + parent-pointer repair. Removes records
  through `cut_through_uuid`, injects a self-authored recap as a new user
  message, and repairs the chain. Dry-run mode, timestamped backups, and atomic
  temp-file-plus-rename writes with rollback on failure.
- **Multi-recap layering** — prior recaps already at the top of a file are
  detected and preserved, so recap-002 compounds on recap-001 instead of
  destroying it.
- **`GET /health`** and **`GET /voices`** — liveness and configured-voice listing.
- **`scripts/recap.ts`** — CLI wrapper around `/surgery` that extracts
  `cut_through_uuid` from the recap body's sentinel automatically; dry-run by
  default, `--go` to execute.
- **Configurable sentinel name** (`sentinel_name`, default `RECAP-CYCLE`) for
  marking and preserving recap injections across cycles.
- **Security hardening** — `allowed_roots` path allowlist with symlink
  resolution and `.jsonl` enforcement, `expose_paths: false` to strip
  filesystem paths from responses, loopback-only binding, body limits, and log
  redaction. See `SECURITY.md`.
- **Pair-balance diagnostics** including the `tail_orphan_only` self-loop signal.
- **Test suite** (Vitest) over hand-crafted JSONL fixtures covering invariants,
  boundaries, the finder, and security regressions.
- **pm2 deploy path** via `npm run build` + `node dist/server.js`.
- Documentation: `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, and the
  `docs/` set (`protocol.md`, `walkthrough.md`, `recap-writing-guide.md`,
  `cache-mechanics.md`).

[1.1.0]: https://github.com/kshvab/selfrecap/releases/tag/v1.1.0
[1.0.0]: https://github.com/kshvab/selfrecap/releases/tag/v1.0.0
