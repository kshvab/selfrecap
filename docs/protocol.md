# Protocol: JSONL records and the recap sentinel

This document specifies the two data shapes `selfrecap` operates on: the Claude Code JSONL transcript record, and the recap sentinel that marks an injected recap. If you are integrating with the tool or extending it, this is the contract.

---

## The JSONL transcript

Claude Code stores each session as a [JSON Lines](https://jsonlines.org/) file: one JSON object per line, appended as the conversation progresses. The file lives at:

```
~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
```

where `<encoded-cwd>` is the session's working directory with path separators replaced by dashes.

`selfrecap` reads these files to measure context size and locate cut points, and (only via `/surgery`) rewrites them. It never invents transcript structure — it preserves whatever Claude Code wrote and only cuts records, inserts one new record, and repairs parent pointers.

### Record shape

Records vary by `type`, but the fields the tool depends on are:

| Field | Type | Meaning |
| --- | --- | --- |
| `uuid` | string | Unique id for this record. The handoff key for cut points. |
| `parentUuid` | string \| null | The `uuid` of the preceding record in the conversation chain. `null` for the first record. This chain is what the tool repairs after a cut. |
| `type` | string | `user`, `assistant`, `system`, and others (e.g. `file-history-snapshot`, attachments). |
| `timestamp` | string (ISO 8601) | When the record was written. Used by the timestamp finder and `before_timestamp` filter. |
| `isSidechain` | boolean | True for sub-agent / sidechain turns. The context monitor ignores sidechain `usage` when computing the live context size. |
| `message` | object | The role + content. For `assistant`/`user` it holds `role` and `content`. |

### Content blocks

`message.content` is either a string or an array of typed blocks. The two block types the tool reasons about:

- **`tool_use`** — `{ type: "tool_use", id, name, input }`. Appears in `assistant` messages.
- **`tool_result`** — `{ type: "tool_result", tool_use_id, content }`. Appears in `user` messages, pairing back to a `tool_use.id`.

A surgery must not leave a `tool_use` without its matching `tool_result` (an "orphan"). The surgery diagnostics report `pair_balance` precisely so you can verify this. The one benign exception is documented below.

### Token accounting

The context monitor (`GET /context`) computes the live context size by scanning backward for the most recent non-sidechain `assistant` message carrying a `usage` object, then summing:

```
input_tokens + cache_read_input_tokens + cache_creation_input_tokens
```

This mirrors how Claude Code itself reports context usage. It is read from the transcript that Claude Code already wrote — the tool does not call any API to compute it.

---

## The recap sentinel

When `/surgery` injects a recap, the new record is a `user` message whose content includes a fenced JSON block carrying a sentinel. This marker lets the tool recognize recaps later — to **preserve** them across future cycles (multi-recap layering) and to **skip** them in cut-point searches (so a search doesn't match text inside a prior recap).

### Sentinel shape

```json
{
  "sentinel": "RECAP-CYCLE",
  "voice": "my-session",
  "id": "my-session-recap-001",
  "version": 1,
  "cut_through_uuid": "<uuid of the last record being cut>",
  "period_covered": "2026-01-01_to_2026-01-15",
  "generated": "2026-01-15",
  "next_recap_should_skip_this": true,
  "format": "pointer-plus-narrative-hybrid",
  "mode": "A-first-person",
  "predecessor_recap": "my-session-recap-000"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `sentinel` | yes | The marker name. Must match the server's configured `sentinel_name` (default `RECAP-CYCLE`). This is what the tool matches on. |
| `voice` | recommended | The session's short name. |
| `id` | recommended | A stable id for this recap (e.g. `<voice>-recap-NNN`). |
| `cut_through_uuid` | yes (for the CLI helper) | The `uuid` of the last record cut. The `scripts/recap.ts` helper extracts this from the body so you don't pass it twice. |
| `period_covered` | recommended | Human-readable date span of what this recap summarizes. |
| `predecessor_recap` | for recap-002+ | The id of the prior recap this one layers on top of. Omit for the first recap. |

Only `sentinel` is structurally load-bearing for the tool. The rest is metadata that helps future readers (you, or the next instance of the session) understand the recap's scope. The body **prose** around the JSON block is the actual recap — written in the session's own voice.

### Configurable sentinel name

The marker string is configurable via `sentinel_name` in `config.yaml` (default `RECAP-CYCLE`). If you have existing recaps authored with a different marker, set `sentinel_name` to match so the tool recognizes them. The server validates that a submitted `recap_content` contains the configured sentinel before performing surgery; a body missing it is rejected.

---

## Multi-recap layering

The tool supports recaps compounding over time without destroying earlier ones.

When `/surgery` runs, it detects **leading recap records** — consecutive recap-sentinel-bearing records at the very start of the file — and preserves them. The new recap is inserted immediately after the last leading recap; the cut range begins after them. So:

```
Before recap-002:                After recap-002:
[recap-001]            ->        [recap-001]              (preserved)
[period-2 verbatim]              [recap-002]              (new, parentUuid -> recap-001.uuid)
[period-3 verbatim]              [period-3 verbatim ...]  (survivors, first parentUuid -> recap-002.uuid)
[cut_through here]
[period-4 verbatim]
```

Surgery diagnostics report `leading_recaps_preserved` (how many were detected and kept) and `new_recap_position` (the line index where the new recap was inserted; equals `leading_recaps_preserved`).

To deliberately overwrite a prior recap rather than layer on top, set `force_overwrite_recap: true` in the surgery request; otherwise a cut range that includes an existing recap is rejected.

---

## The `tail_orphan_only` flag

A surgery's `pair_balance` reports `tool_use`, `tool_result`, and `orphans` counts, plus a boolean `tail_orphan_only`.

`tail_orphan_only` is true when the **only** unmatched `tool_use` is a single one in the very last record of the resulting file. This is the signature of a session running surgery on *itself*: the in-flight tool call that fired the surgery script is in the transcript, but its `tool_result` has not landed yet (it lands after the surgery completes, when the tool returns). In that case the orphan is benign — it resolves the moment the surgery call returns and the result is written. Any other orphan shape (`tail_orphan_only: false` with `orphans > 0`) indicates a real structural problem and should be investigated before trusting the result.

---

## Versioning

The sentinel `version` field is reserved for future format changes. v1 is the shape documented here. If the sentinel format changes incompatibly, the tool will key migration behavior off this field.
