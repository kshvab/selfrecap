# recap-cycle

> HTTP API for Claude Code session continuity. Find clean cut points in JSONL session files, monitor context-window size, and perform self-authored "recap surgery" — an alternative to lossy auto-compaction for long-lived AI coding sessions.

**Status:** v1.0.0 — ships `find-cut-point` + `context` + `contexts` + `surgery` endpoints, multi-recap layering, atomic backed-up writes, security hardening, and a pm2 deploy path. A Claude Code skill file, npm publish, and Docker image are on the roadmap.

---

## What it is

Long-lived Claude Code sessions eventually fill the context window. The built-in `/compact` solves this by replacing your transcript with a machine summary written in a generic voice. For a quick utility session that is fine. For a session you have invested days of context into — accumulated decisions, conventions, working relationships, a recognizable way of thinking — auto-compaction is lossy in a way that is hard to recover from. The thread comes back subtly not-itself: someone else's summary of who it was.

`recap-cycle` implements a different shape. Instead of letting an external summarizer overwrite the past, the session **writes its own recap of its oldest stretch, in its own voice**. The tool then performs surgery on the transcript file on disk: it hard-cuts the old verbatim records, injects the self-authored recap as a single message at the top, and repairs the parent-pointer chain so the conversation flows cleanly from recap to the surviving records. After a restart, the session resumes reading its own summary of its own history. Recognition instead of replacement.

This is a real file-mutation tool. It rewrites the JSONL transcript that Claude Code reads on resume. It always writes a timestamped backup first, supports a dry-run mode that changes nothing, and enforces safety invariants (the cut target must exist, the recap must carry a sentinel marker, prior recaps are preserved) before touching a byte. Read [SECURITY.md](./SECURITY.md) before you point it anywhere but your own machine.

### A note on "voice"

A **voice** is a configurable short name for one of your Claude Code sessions (for example `my-session` or `voice-a`). The term reflects this tool's origin — identity-preserving recaps for long-lived AI personas, where each session is a recognizable voice. Call them whatever you like; voice names are convenience, and you can always pass a `file_path` directly instead.

---

## Quickstart

Requirements: Node.js >= 20.

```bash
git clone <repo-url> recap-cycle
cd recap-cycle
npm install
cp config.example.yaml config.yaml
# edit config.yaml — register your session(s) under `voices:`
npm start
```

On Windows PowerShell, replace the copy step:

```powershell
Copy-Item config.example.yaml config.yaml
```

The server listens on `http://127.0.0.1:9090` by default (loopback only). Edit `config.yaml` to register your sessions:

```yaml
server:
  port: 9090
  host: 127.0.0.1

voices:
  my-session:
    path: "/Users/you/.claude/projects/-Users-you-projects-my-app/00000000-0000-0000-0000-000000000000.jsonl"

allowed_roots:
  - "~/.claude/projects/"

expose_paths: false
sentinel_name: "RECAP-CYCLE"
backup_dir: "./backups"
```

See [`config.example.yaml`](./config.example.yaml) for the fully commented version, including how to locate your session's JSONL file on macOS, Linux, and Windows.

### Finding your session file

Claude Code stores transcripts at `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`, where `<encoded-cwd>` is the session's working directory with path separators replaced by dashes.

```bash
# macOS / Linux
ls -t ~/.claude/projects/*/*.jsonl | head
```

```powershell
# Windows PowerShell
Get-ChildItem "$env:USERPROFILE\.claude\projects\*\*.jsonl" | Sort-Object LastWriteTime -Descending | Select-Object -First 5
```

### Production (pm2)

```bash
npm run build
pm2 start dist/server.js --name recap-cycle
```

---

## API surface

All endpoints are served over loopback. POST routes mutate or compute against your transcript files; treat the server as a local tool, not a public service.

### `GET /health`

Liveness check.

```bash
curl http://127.0.0.1:9090/health
```

```json
{
  "status": "ok",
  "version": "1.0.0",
  "voices_registered": 1,
  "voices_missing_file": 0
}
```

### `GET /voices`

List configured voices and per-file state.

```bash
curl http://127.0.0.1:9090/voices
```

```json
{
  "voices": {
    "my-session": {
      "exists": true,
      "file_size_bytes": 3440000,
      "last_modified": "2026-01-08T12:00:00.000Z"
    }
  }
}
```

When `expose_paths: false` (the default), the filesystem `path` is omitted from this response.

### `GET /context/:voice` (also `GET /context?path=...`)

Read the current context-window size for a session. Computed the way Claude Code's own `/context` does: scan backward for the last non-sidechain `assistant` record with a `usage` block, then sum `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.

```bash
curl http://127.0.0.1:9090/context/my-session
# or, for any path without registering a voice:
curl "http://127.0.0.1:9090/context?path=/absolute/path/to/session.jsonl"
```

```json
{
  "voice": "my-session",
  "file": "/.../session.jsonl",
  "tokens_total": 528000,
  "percent_of_1m": 52.8,
  "input_tokens": 6,
  "cache_read_tokens": 525256,
  "cache_creation_tokens": 2726,
  "output_tokens": 1392,
  "file_size_bytes": 3440000,
  "line_count": 2032,
  "last_usage_ts": "2026-01-08T12:00:00.000Z",
  "last_usage_line_idx": 2030
}
```

`tokens_total` is what counts toward the 1M context window. `output_tokens` is reported but does not count toward input context.

### `GET /contexts`

A single-call snapshot of every configured voice. Per-voice errors (missing file, no usage entries) are isolated — one bad voice does not break the rest.

```bash
curl http://127.0.0.1:9090/contexts
```

```json
{
  "snapshot_at": "2026-01-08T12:00:00.000Z",
  "voice_count": 2,
  "voices": {
    "my-session": {
      "exists": true,
      "tokens_total": 528000,
      "percent_of_1m": 52.8,
      "line_count": 2032,
      "last_usage_ts": "2026-01-08T12:00:00.000Z",
      "last_usage_line_idx": 2030
    },
    "voice-a": {
      "exists": false,
      "error": "file_not_found"
    }
  }
}
```

### `POST /find-cut-point`

Locate a record in a session by description. The session describes a target moment by phrase, timestamp, or anchor-plus-offset; the server returns matching records — each with its `uuid` (the handoff key for surgery) plus a surrounding context window for verification.

```bash
curl -X POST http://127.0.0.1:9090/find-cut-point \
  -H "Content-Type: application/json" \
  -d '{
    "voice": "my-session",
    "method": "marker_phrase",
    "phrase": "the night we locked the naming convention",
    "exclude_recap": true,
    "limit": 50
  }'
```

`method` options:

- `marker_phrase` — exact substring search across all record text (message text, tool_use input, tool_result content, thinking blocks). Specify `phrase`.
- `timestamp` — the last record before a given ISO timestamp. Specify `before`.
- `anchor_offset` — find `anchor_phrase`, then move `offset` records in `direction` (`before` / `after`).

Other fields: `exclude_recap` (default `true`, skips records carrying the recap sentinel), `limit` (default 50, max 500), `before_timestamp` (drop matches at or after this ISO time — useful for filtering out your current session's own activity).

```json
{
  "method": "marker_phrase",
  "spec": { "method": "marker_phrase", "phrase": "...", "limit": 50 },
  "exclude_recap": true,
  "total_matches": 1,
  "returned_count": 1,
  "limit": 50,
  "truncated": false,
  "matches": [
    {
      "line_index": 1032,
      "uuid": "8f2de964-5d86-4fe0-83b3-f6437c3b15b2",
      "parent_uuid": "1387e89b-0000-0000-0000-000000000000",
      "timestamp": "2026-01-07T10:39:09.219Z",
      "type": "user",
      "role": "user",
      "content_preview": "the night we locked the naming convention...",
      "selectable": true,
      "context_before": [],
      "context_after": []
    }
  ],
  "voice": "my-session",
  "file": "/.../session.jsonl",
  "total_lines": 2050
}
```

Only records with `selectable: true` (those with a `uuid`) can be used as a cut target. The `uuid` of the chosen match is what you pass to `/surgery` as `cut_through_uuid`. See [docs/walkthrough.md](./docs/walkthrough.md) for tips on writing distinctive phrases and handling multibyte content.

### `POST /surgery`

Cut, inject, and repair in one operation. Removes records from the start of the file through `cut_through_uuid` (preserving any prior recaps already at the top), injects `recap_content` as a new user message, and repairs the parent-pointer chain.

```bash
curl -X POST http://127.0.0.1:9090/surgery \
  -H "Content-Type: application/json" \
  -d '{
    "voice": "my-session",
    "cut_through_uuid": "8f2de964-5d86-4fe0-83b3-f6437c3b15b2",
    "recap_content": "Hey. Here is what you wrote so we would have room to keep going... <full recap, ending with the sentinel JSON block>",
    "dry_run": true,
    "force_overwrite_recap": false
  }'
```

`recap_content` must contain the recap sentinel JSON (default marker `RECAP-CYCLE`); the server rejects the request with a format hint if it is missing. **Always run with `dry_run: true` first** — it computes and returns full diagnostics without touching the file.

```json
{
  "ok": true,
  "dry_run": true,
  "diagnostics": {
    "file_path": "/.../session.jsonl",
    "backup_path": null,
    "total_lines_before": 2050,
    "total_lines_after": 1018,
    "cut_through_line_idx": 1032,
    "lines_cut": 1033,
    "new_recap_uuid": "638dc4c9-0000-0000-0000-000000000000",
    "sentinel_invariant_passed": true,
    "cut_range_has_existing_recap": false,
    "leading_recaps_preserved": 0,
    "new_recap_position": 0,
    "file_size_before_bytes": 3440000,
    "file_size_after_bytes": 1700000,
    "pair_balance": {
      "tool_use": 491,
      "tool_result": 491,
      "orphans": 0,
      "tail_orphan_only": false
    }
  }
}
```

When `dry_run: false` and surgery succeeds, the file is rewritten atomically (temp file + rename, restored from backup on failure) and `backup_path` points to the pre-surgery copy in `backup_dir`. The CLI helper `scripts/recap.ts` wraps this endpoint and extracts `cut_through_uuid` from the recap body's sentinel automatically — see the walkthrough.

For the full diagnostics field reference and the safety invariants, see [docs/protocol.md](./docs/protocol.md).

---

## Security model

`POST /surgery` rewrites files. Misconfigured and exposed beyond localhost, that is a remote file-write primitive. The defenses, in brief:

- **Loopback only.** The server binds `127.0.0.1` by default. Do not bind `0.0.0.0` without adding TLS and real auth.
- **`allowed_roots` allowlist.** Only files resolving (after symlink resolution) under a configured root may be read or written, and the `.jsonl` suffix is required. A `file_path` of `../../etc/passwd` or a symlink pointing outside the allowlist is rejected.
- **`expose_paths: false`.** By default, filesystem paths are stripped from responses so a stray public clone cannot leak your home-directory layout.
- **Dry-run + backups + atomic writes.** Nothing is mutated without a successful backup first, and a failed write is rolled back from that backup.

The full threat model, the auth-token / Origin-rejection / Host-loopback layers, and the vulnerability-disclosure path are in [SECURITY.md](./SECURITY.md).

---

## The recap flow, end to end

1. **Monitor.** `GET /context/:voice` (or `/contexts`) to watch token usage climb. When you approach the wall, it is time.
2. **Find the cut point.** `POST /find-cut-point` with a distinctive phrase from a natural arc-end (a session close, the completion of a major work cycle). Confirm you have the right record by its `content_preview` and surrounding context. Note its `uuid`.
3. **Write the recap body.** Author a single content-only file — your own summary of the period being compressed, ending with a sentinel JSON block that includes the `cut_through_uuid`. See [docs/recap-writing-guide.md](./docs/recap-writing-guide.md).
4. **Dry-run.** `POST /surgery` with `dry_run: true` (or `npx tsx scripts/recap.ts <voice> <body-file>`). Read the diagnostics — `lines_cut`, `pair_balance` (tool_use and tool_result should be equal, orphans `0`), `cut_range_has_existing_recap` (should be `false` unless you intend an overwrite).
5. **Execute.** Re-run with `dry_run: false` (or add `--go`). The file is backed up and rewritten.
6. **Restart.** Surgery changes the file on disk, not the running session's in-memory state. Stop the session and `claude --resume <session-id>` to force a re-read. See [docs/cache-mechanics.md](./docs/cache-mechanics.md).
7. **Verify.** `GET /context/:voice` should show a sharp token drop after the first post-resume turn. Optionally read random pre-cut lines from the backup to confirm theme-level recall survived.

A complete worked example with generic placeholders is in [docs/walkthrough.md](./docs/walkthrough.md).

---

## Documentation

- [docs/walkthrough.md](./docs/walkthrough.md) — a full worked example, register-to-verify.
- [docs/protocol.md](./docs/protocol.md) — the JSONL record shape and the recap sentinel specification.
- [docs/recap-writing-guide.md](./docs/recap-writing-guide.md) — how to write a recap that preserves continuity (field notes from the original deployment).
- [docs/cache-mechanics.md](./docs/cache-mechanics.md) — why a restart is required, and the two-layer cache model.
- [SECURITY.md](./SECURITY.md) — threat model and disclosure.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — dev setup and how to add a route.

---

## The /remember skill

[`skills/remember/SKILL.md`](./skills/remember/SKILL.md) is a Claude Code skill that lets a long-lived session run the recap cycle on *itself*, autonomously: read its own context size, find a clean cut point, author the recap body in its own voice, dry-run, execute, and report the restart commands back to the operator. It drives the same end-to-end flow as [docs/walkthrough.md](./docs/walkthrough.md), but the session does the work instead of you doing it by hand. Install it by copying the skill folder into your Claude Code skills directory:

```bash
cp -r skills/remember ~/.claude/skills/
```

Then the session can run `/remember` when it nears the context wall. (It is named `/remember` because `/recap` is a reserved native Claude Code command.)

---

## Roadmap

**Shipped (v1.0.0):**

- `POST /find-cut-point`, `GET /context`, `GET /contexts`, `POST /surgery`
- Multi-recap layering (recap-002 compounds on recap-001 instead of destroying it)
- Atomic backed-up writes, dry-run mode, configurable sentinel name
- Security hardening (allowed_roots, expose_paths, loopback binding)
- The `/remember` Claude Code skill (sessions invoke the recap cycle on themselves)
- pm2 deploy path, test suite

**Future:**

- `npm publish` and a Docker image
- A `/trim` endpoint (file-level noise removal — a separate concern from recap)
- Watchdog automation (threshold-triggered self-recap proposals)
- A proper auth layer (bearer + TLS) for non-localhost deployment

---

## Acknowledgements & origin

The architecture was prototyped and validated end-to-end on the author's own long-lived sessions before being generalized for release; case studies live in the author's experiments archive. The contribution that distinguishes this tool: **AI-authored, layered, in-voice recaps as a compaction strategy** — the shape that preserves felt continuity across cycles for sessions carrying real accumulated context.

It owes a debt to neighboring work on long-session continuity, each addressing a different slice of the problem: JSONL noise-removal strategies, persistent memory via lifecycle hooks, tool-output sandboxing, and bare-bones transcript JSON manipulation.

---

## License

MIT.
