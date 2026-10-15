# Walkthrough: a recap from start to finish

This is a complete worked example: register a session, read its plan, find a cut point, write a recap, perform the surgery, restart, and verify. Placeholders use generic names; substitute your own. (The `/remember` skill runs steps 2–7 for a session on itself; this is the same flow by hand.)

Prerequisites: the server is running (`npm start`), and you know which Claude Code session you want to recap. Every command below runs in the selfrecap folder.

---

## 1. Register the session as a voice

Find your session's JSONL file:

```bash
# macOS / Linux
ls -t ~/.claude/projects/*/*.jsonl | head

# Windows PowerShell
Get-ChildItem "$env:USERPROFILE\.claude\projects\*\*.jsonl" | Sort-Object LastWriteTime -Descending | Select-Object -First 5
```

Add it to `config.yaml`, with a folder for its recap bodies and the command that resumes it:

```yaml
voices:
  my-session:
    session: "~/.claude/projects/-Users-you-projects-app/<session-uuid>.jsonl"
    recaps: "~/selfrecap-voices/my-session"
    restart: "cd ~/projects/app && claude --resume {session_id} --name My-session"
```

Check it with `npm run check-config`, then restart the server so it picks up the new voice. (You can skip registration and pass `file_path` directly in every request, but a registered voice is less to type, follows continued sessions, and gets a recap plan.)

---

## 2. Read the plan

```bash
npx tsx scripts/recap.ts my-session --plan
```

```
─── Recap plan: my-session ───
Context        81.2% (812,000 tokens), last usage 2026-01-15T10:04:11.000Z
Headroom       158,000 tokens to 97%, 40,000 kept for the rest of the protocol: write the body in under ~295,000 characters
Session        <session-uuid>
Recap stack    none yet: this is your first recap
Next recap     my-session-recap-001
Body file      /Users/you/selfrecap-voices/my-session/recap-001.body.txt  (not written yet)
Sentinel       "sentinel": "RECAP-CYCLE", "voice": "my-session", "id": "my-session-recap-001"
Search cutoff  2026-01-15T09:59:11.000Z  (now minus 5 minutes; --find uses it)
Restart        cd ~/projects/app && claude --resume <session-uuid> --name My-session
```

If the context is comfortably under your threshold, you don't need a recap yet. Recap when the session is large enough that the next stretch of work risks hitting the wall — typically well before you actually run out, while there is still room to author a thoughtful recap. The Headroom line says how long the body can be.

---

## 3. Find the cut point

A good cut point is a real phase boundary: the end of one mode of work, just before a different mode begins. Not an arbitrary percentage. Search for a distinctive phrase from the user message that opened the new mode:

```bash
npx tsx scripts/recap.ts my-session --find "now let's move on to the dashboard"
```

```
─── 1 match(es) for "now let's move on to the dashboard" before 2026-01-15T09:59:11.000Z ───
   1032  user                       aaaaaaaa-…  ← bbbbbbbb…  2026-01-14 18:20:03  now let's move on to the dashboard…
Boundary: the user message at line 1032. Cut through its parent: bbbbbbbb-…
Read the seam first: npx tsx scripts/recap.ts my-session --around 1032
```

The cut goes through the boundary message's **parent** — the record the conversation stood on when it arrived (usually a `system` record after the last reply). Everything from the start of the cut range through that record gets replaced by your recap; the boundary message itself stays, opening the surviving part. Read the seam before you commit to it:

```bash
npx tsx scripts/recap.ts my-session --around 1032
```

The search only looks before the plan's cutoff, so it does not match the conversation where you are discussing the search itself. Other ways in: `--at <ISO time>` (the last record before a moment), or `POST /find-cut-point` directly (with the `X-Recap-Token` header; see the README) for the `anchor_offset` method.

---

## 4. Write the recap body

Write the body file at the plan's Body file path. Write, in the session's own voice, a summary of the period being cut: the decisions made and why, the state of the work, open threads, working conventions established. Keep what will still matter next week; drop tactical detail that lives in your commit history.

End the file with a fenced JSON block carrying the sentinel, with the values from the plan:

````text
Hey. Here is the auth + early-dashboard period, told back to you.

You shipped the auth refactor (token rotation, the session-fixation fix) and
locked the decision to keep sessions server-side rather than JWT. The dashboard
work began after — that is still live in the surviving transcript below, so it
is not repeated here. Open thread: the rate-limiter config is still a guess and
wants real numbers once there is traffic.

```json
{"sentinel":"RECAP-CYCLE","voice":"my-session","id":"my-session-recap-001","cut_through_uuid":"<the uuid from step 3>","period_covered":"2026-01-08_to_2026-01-14","generated":"2026-01-15"}
```
````

The CLI helper in the next step reads `cut_through_uuid` from this block so you don't pass it separately. The server checks the `voice` and the `id` against the session's recap stack.

---

## 5. Dry-run the surgery

The helper reads your body from the plan's path, extracts the cut point from the sentinel, and calls `/surgery` in dry-run mode (no file change):

```bash
npx tsx scripts/recap.ts my-session
```

(An explicit body file still works: `recap.ts my-session path/to/body.txt`.) Read the diagnostics:

- `ok: true`, and `recap_id` equals `expected_recap_id`
- `cut_through_line_idx` — the record just before your boundary message
- `lines_cut` / `total_lines_after` — confirm the cut spans what you expect
- `leading_recaps_preserved` / `new_recap_position` — for a first recap `0`, and the position just after any header records
- `chain_reaches_recap: true`, `cut_orphaned_tool_results: 0`
- `pair_balance` — `orphans: 0`, or `tail_orphan_only: true` if you are running this from inside the session itself

A refusal names what to fix. If anything looks off, adjust your cut point or body and dry-run again. Nothing has been written yet.

---

## 6. Execute

When the dry-run looks right, run it for real:

```bash
npx tsx scripts/recap.ts my-session --go
```

The server writes a verified backup to `backup_dir` first, then performs the cut, injects your recap, re-points the records whose parent was cut, and swaps the file in — carrying over anything the session appended meanwhile. The output includes `backup_path` and ends with the restart command.

The change is on disk. The running session is still using its in-memory copy from before — the surgery does not affect a live session until it reloads the file.

---

## 7. Restart the session

Close the Claude Code session and run the restart command the `--go` output printed — in essence, in the session's folder:

```bash
claude --resume <session-uuid>
```

On resume, Claude Code re-reads the (now rewritten) transcript. The session comes back reading its own recap as the opening of its history, followed by the surviving records. See [cache-mechanics.md](./cache-mechanics.md) for why a restart is required rather than a live reload. (On Windows a session can do this itself with `selfrecap restart`; see the README.)

---

## 8. Verify

- `curl http://127.0.0.1:9090/contexts` — the token count should have dropped substantially after the first post-resume turn, and `stale_reading` should be `false`.
- The backup (`backup_path`, in `backup_dir/<voice>/`) is your safety net. If the recap reads wrong or something feels broken, close the session and restore it:
  ```bash
  cp <backup_path> <original-jsonl-path>
  ```
  then restart again and revise the recap.

That is the full cycle. The next time the session fills up, you can recap again — the new recap will layer on top of this one (see multi-recap layering in [protocol.md](./protocol.md)).
