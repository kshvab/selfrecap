# Walkthrough: a recap from start to finish

This is a complete worked example: register a session, check its size, find a cut point, write a recap, perform the surgery, restart, and verify. Placeholders use generic names; substitute your own.

Prerequisites: the server is running (`npm start`), and you know which Claude Code session you want to recap.

---

## 1. Register the session as a voice

Find your session's JSONL file:

```bash
# macOS / Linux
ls -t ~/.claude/projects/*/*.jsonl | head

# Windows PowerShell
Get-ChildItem "$env:USERPROFILE\.claude\projects\*\*.jsonl" | Sort-Object LastWriteTime -Descending | Select-Object -First 5
```

Add it to `config.yaml`:

```yaml
voices:
  my-session:
    path: "/Users/you/.claude/projects/-Users-you-projects-app/<session-uuid>.jsonl"
```

Restart the server so it picks up the new voice. (You can skip registration and pass `file_path` directly in every request, but a registered voice is less to type.)

---

## 2. Check the context size

```bash
curl -s http://127.0.0.1:9090/context/my-session
```

```json
{
  "voice": "my-session",
  "tokens_total": 168240,
  "percent_of_1m": 16.8,
  "line_count": 2143,
  "last_usage_ts": "2026-01-15T10:04:11.000Z"
}
```

If `percent_of_1m` is comfortably under your threshold, you don't need a recap yet. Recap when the session is large enough that the next stretch of work risks hitting the wall — typically well before you actually run out, while there is still room to author a thoughtful recap.

---

## 3. Find the cut point

A good cut point is a real phase boundary: the end of one mode of work, just before a different mode begins. Not an arbitrary percentage. Search for a distinctive phrase from around that boundary:

```bash
curl -s http://127.0.0.1:9090/find-cut-point \
  -X POST -H "Content-Type: application/json" \
  --data-binary @- <<'EOF'
{
  "voice": "my-session",
  "method": "marker_phrase",
  "phrase": "shipped the auth refactor and moved on to the dashboard",
  "exclude_recap": true,
  "before_timestamp": "2026-01-15T09:55:00Z"
}
EOF
```

The response lists matches with their `uuid`, `line_index`, `timestamp`, and a content preview. `exclude_recap` skips any prior recap records; `before_timestamp` filters out matches from the current moment (useful so your search doesn't match the conversation where you're discussing the search itself).

Pick the `uuid` of the assistant message that *ends* the period you want to compress. That is your `cut_through_uuid` — everything from the start of the cut range through that record gets replaced by your recap.

Other finder methods: `timestamp` (latest record before a cutoff) and `anchor_offset` (find a phrase, then offset N records in a direction). See the API surface in the README.

---

## 4. Write the recap body

Create a plain text file — for example `recap-body.txt`. Write, in the session's own voice, a summary of the period being cut: the decisions made and why, the state of the work, open threads, working conventions established. Keep what will still matter next week; drop tactical detail that lives in your commit history.

End the file with a fenced JSON block carrying the sentinel:

````text
Recap of the auth + early-dashboard period.

I shipped the auth refactor (token rotation, the session-fixation fix) and
locked the decision to keep sessions server-side rather than JWT. The dashboard
work began after — that is still live in the surviving transcript below, so I am
not repeating it here. Open thread: the rate-limiter config is still a guess and
wants real numbers once we have traffic.

```json
{"sentinel":"RECAP-CYCLE","voice":"my-session","id":"my-session-recap-001","cut_through_uuid":"<paste the uuid from step 3>","period_covered":"2026-01-08_to_2026-01-15","generated":"2026-01-15"}
```
````

The sentinel JSON must contain your configured `sentinel_name` (default `RECAP-CYCLE`) and the `cut_through_uuid`. The CLI helper in the next step reads `cut_through_uuid` from this block so you don't pass it separately.

---

## 5. Dry-run the surgery

The helper script reads your body file, extracts the cut point from the sentinel, and calls `/surgery` in dry-run mode (no file change):

```bash
npx tsx scripts/recap.ts my-session recap-body.txt
```

Read the diagnostics:

- `ok: true` and `sentinel_invariant_passed: true`
- `cut_through_line_idx` / `lines_cut` — confirm the cut spans what you expect
- `total_lines_after` — the file's new size
- `leading_recaps_preserved` / `new_recap_position` — for a first recap these are `0` and `0`
- `pair_balance` — `tool_use` should equal `tool_result`, `orphans: 0` (or `orphans: 1` with `tail_orphan_only: true` if you are running this from inside the session itself)

If anything looks off, adjust your cut point or body and dry-run again. Nothing has been written yet.

---

## 6. Execute

When the dry-run looks right, run it for real:

```bash
npx tsx scripts/recap.ts my-session recap-body.txt --go
```

The server writes a timestamped backup to `backup_dir` first, then performs the cut, injects your recap, repairs the parent-pointer chain, and writes the file atomically. The response includes `backup_path` and the `new_recap_uuid`.

The change is on disk. The running session is still using its in-memory copy from before — the surgery does not affect a live session until it reloads the file.

---

## 7. Restart the session

Close the Claude Code session and resume it:

```bash
claude --resume <session-uuid>
```

On resume, Claude Code re-reads the (now rewritten) transcript. The session comes back reading its own recap as the opening of its history, followed by the surviving records. See [cache-mechanics.md](./cache-mechanics.md) for why a restart is required rather than a live reload.

---

## 8. Verify

- `curl http://127.0.0.1:9090/context/my-session` — the token count should have dropped substantially.
- The backup at `backup_path` is your safety net. If the recap reads wrong or something feels broken, restore it:
  ```bash
  cp <backup_path> <original-jsonl-path>
  ```
  then restart again and revise the recap.

That is the full cycle. The next time the session fills up, you can recap again — the new recap will layer on top of this one (see multi-recap layering in [protocol.md](./protocol.md)).
