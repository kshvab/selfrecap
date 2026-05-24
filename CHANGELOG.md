# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-01-08

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

[1.0.0]: https://github.com/OWNER/recap-cycle/releases/tag/v1.0.0
