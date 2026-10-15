# Protocol: JSONL records and the recap sentinel

This document specifies the two data shapes `selfrecap` operates on: the Claude Code JSONL transcript record, and the recap sentinel that marks an injected recap. If you are integrating with the tool or extending it, this is the contract.

---

## The JSONL transcript

Claude Code stores each session as a [JSON Lines](https://jsonlines.org/) file: one JSON object per line, appended as the conversation progresses. The file lives at:

```
~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
```

where `<encoded-cwd>` is the session's working directory with every character that is not a letter or digit replaced by a dash.

When Claude Code continues a session into a new file, it appends a record `{"type":"continued-in","continuedInSessionId":"<new id>"}` to the old one and stops writing it. selfrecap follows these records from a voice's configured file to the live one (see the README, "Session continuation").

`selfrecap` reads these files to measure context size and locate cut points, and (only via `/surgery`) rewrites them. It never invents transcript structure — it preserves whatever Claude Code wrote, byte for byte, and only cuts records, inserts one new record, and re-points the parents of records whose parent was cut.

### Record shape

Records vary by `type`, but the fields the tool depends on are:

| Field | Type | Meaning |
| --- | --- | --- |
| `uuid` | string | Unique id for this record. The handoff key for cut points. |
| `parentUuid` | string \| null | The `uuid` of the preceding record in the conversation chain. `null` for the first record. This chain is what the tool repairs after a cut. |
| `type` | string | `user`, `assistant`, `system`, and others (e.g. `file-history-snapshot`, `last-prompt`, `attachment`, `queue-operation`). Some carry no `uuid`: Claude Code writes such metadata records ahead of the conversation (header records) and between turns. |
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

When `/surgery` injects a recap, the new record is a `user` message whose content ends with a fenced JSON block carrying a sentinel. This marker lets the tool recognize recaps later — to **preserve** them across future cycles (multi-recap layering) and to **skip** them in cut-point searches (so a search doesn't match text inside a prior recap).

### What counts as a recap

A **recap record** is a `user` record (not `isMeta`) whose content is a plain string carrying `"sentinel": "<sentinel_name>"` (any spacing). Recognition does not require the block to parse, so recaps written by 1.0 with a slightly broken block stay recognized and protected. A **new** body is held to more: its sentinel must parse as JSON. When a body contains several sentinel objects (quoting a predecessor, say), the **last** one counts; if that last one does not parse, the body has no sentinel (it never falls back to the quoted one).

Not recaps, even when they contain the sentinel text: a `tool_result` that read a body file, assistant text, a `queue-operation`, text Claude Code generates itself (slash-command echoes, task notifications, interrupt markers), or a sentinel-shaped string that is not a JSON object. Before 1.1 any record whose text contained the sentinel counted, which made the overwrite guard fire on routine work.

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
| `voice` | recommended | The session's voice name. When given and the request names a voice, they must match (`sentinel_voice_mismatch`). |
| `id` | recommended | `<voice>-recap-NNN`. For a voice, the server requires the next number in the session's recap stack (`sentinel_id_mismatch` names the expected id); the recap plan gives it. Without an id the surgery still runs, with a warning. |
| `cut_through_uuid` | yes (for the CLI helper) | The `uuid` of the last record cut. The `scripts/recap.ts` helper extracts this from the body so you don't pass it twice; if both are given they must agree. |
| `period_covered` | recommended | Human-readable date span of what this recap summarizes. |
| `predecessor_recap` | for recap-002+ | The id of the prior recap this one layers on top of. Omit for the first recap. |

`sentinel` is what makes a record a recap; `voice`, `id` and `cut_through_uuid` are checked as above. The rest is metadata that helps future readers (you, or the next instance of the session) understand the recap's scope. The body **prose** before the JSON block is the actual recap — written in the session's own voice.

### Configurable sentinel name

The marker string is configurable via `sentinel_name` in `config.yaml` (default `RECAP-CYCLE`). If you have existing recaps authored with a different marker, set `sentinel_name` to match so the tool recognizes them. The server validates that a submitted `recap_content` contains the configured sentinel before performing surgery; a body missing it is rejected.

---

## Multi-recap layering

The tool supports recaps compounding over time without destroying earlier ones.

When `/surgery` runs, it finds the **leading region**: any header records (uuid-less metadata) and the consecutive recap records at the start of the file — the **recap stack**. It keeps the region byte for byte, inserts the new recap right after it, and cuts from there through `cut_through_uuid`. So:

```
Before recap-002:                After recap-002:
[header records]       ->        [header records]          (kept, bytes untouched)
[recap-001]                      [recap-001]               (kept)
[period-2 verbatim]              [recap-002]               (new, parentUuid -> recap-001.uuid)
[cut_through here]               [period-3 verbatim ...]   (survivors; those whose parent was cut -> recap-002.uuid)
[period-3 verbatim]
```

Every recap at the head counts, whoever signed it: none of them may be cut. The next recap number is one past the highest numbered id in the stack (or the stack size plus one when some ids carry no number).

Surgery diagnostics report `leading_recaps_preserved` (the size of the stack) and `new_recap_position` (the line index where the new recap was inserted: after the stack and any header records, so it can be larger than `leading_recaps_preserved`).

A recap record **outside** the stack inside the cut range (an older recap that ended up mid-file, or a body pasted into the conversation) is refused with `cut_range_contains_recap`, naming its line and id. Set `force_overwrite_recap: true` only when it is a pasted copy you mean to delete. A cut point inside the stack itself is refused outright (`cut_inside_recap_stack`).

### Chain repair

Claude Code rebuilds a resumed session by walking `parentUuid` back from the last message. After the cut, every surviving record whose parent was in the cut range is re-pointed to the new recap (`repointed_records`), and the server walks the chain itself: `chain_reaches_recap` must be true, or the surgery is refused with `chain_broken` and the `chain_break` that stopped the walk. (Before 1.1 only the next *line* was re-pointed; when that line was a metadata record, the resumed session never reached its recaps.)

A cut through the newest message is refused too (`cut_at_the_end`): the next record Claude Code writes would hang off a record that is gone.

The server also refuses a cut that removes the `tool_use` of a `tool_result` that survives (`cut_splits_tool_call`; cut at the end of a turn instead) and a cut through a user message whose reply survives (`cut_is_user_message`: the message that opens your new arc would be lost — cut through its parent instead).

---

## The `tail_orphan_only` flag

A surgery's `pair_balance` reports `tool_use`, `tool_result`, and `orphans` counts, plus a boolean `tail_orphan_only`.

`tail_orphan_only` is true when every unmatched `tool_use` sits in the last conversation record of the resulting file, and that record is an assistant message. This is the signature of a session running surgery on *itself*: the in-flight tool call that fired the surgery script is in the transcript, but its `tool_result` has not landed yet (it lands after the surgery completes, when the tool returns). In that case the orphan is benign — it resolves the moment the surgery call returns and the result is written. Any other orphan shape (`tail_orphan_only: false` with `orphans > 0`) indicates a real structural problem and should be investigated before trusting the result.

---

## Versioning

The sentinel `version` field is reserved for future format changes. v1 is the shape documented here. If the sentinel format changes incompatibly, the tool will key migration behavior off this field.
