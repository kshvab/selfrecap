# Cache mechanics: why a restart is required

> Field note from the original deployment. The behavior described here was learned empirically across many surgeries on real long-lived sessions. If your Claude Code version behaves differently, trust your observation over this doc and please open an issue.

The single most common confusion with recap surgery is: *"I ran the surgery, the file changed on disk, but my session still acts like nothing happened."* That is expected. This explains why, and what to do about it.

---

## Two layers of state

A running Claude Code session's context is held in **two places**:

1. **The on-disk JSONL transcript** — the file `selfrecap` reads and rewrites. This is the durable record.
2. **The client's in-memory working copy** — what the running session is actually reasoning over right now. The client loads the transcript into memory when the session starts (or resumes) and works from that copy.

There is also a server-side layer (the API's prompt cache), but for the purpose of "why didn't my surgery take effect," the decisive one is the client's in-memory copy.

`selfrecap` only ever touches layer 1. It cannot reach into a running client's memory. So a surgery performed while a session is live changes the file underneath a client that is still working from its pre-surgery in-memory snapshot. The change is real on disk; the live session simply isn't reading from disk anymore.

---

## The restart is the reload

The client re-reads the transcript from disk on session **start / resume** — not continuously. So the way to make a surgery take effect is:

```bash
# close the running session, then:
claude --resume <session-uuid>
```

Run it in the session's own folder (`claude --resume` finds sessions by folder), on its own account — the restart command `recap.ts --go` prints does both. On Windows the session can do it itself with `selfrecap restart` (see the README).

On resume, the client loads the now-rewritten file. The session comes back reading its recaps (earlier ones first, the new one last) as the opening of its history. This is not a workaround; it is the intended sequence. Surgery writes the file; restart loads it.

The first turn after the restart costs a little more than usual: the server-side prompt cache matches only an identical prefix, and the start of the conversation just changed, so that turn re-processes the prompt once. Later turns hit the cache again.

A mid-session "reload" is not how the client works. Do not expect to trigger the new state without restarting. Several times during development this was misdiagnosed as a caching bug; it is not a bug, it is the load model.

---

## Practical sequence

1. Run the surgery (`--go`). The file is rewritten; a backup is saved.
2. Fully close the session.
3. Run the restart command `--go` printed (in essence `claude --resume <session-uuid>` in the session's folder).
4. On the first turn after resume, the client is working from the new transcript.

The minimum that reliably works is: close, resume, continue. Extra ceremony (cold-instance warm-ups, multiple restarts) was tried during development and found unnecessary — close-and-resume is sufficient.

---

## A note on self-detection

One observation worth passing on, because it surprised every session that went through it: **a resumed session cannot reliably tell, from the inside, that it was just rewritten.** The continuity feels seamless even when, externally, a restart and a file-rewrite just happened. The session will often report "same session, nothing changed" with full confidence — and be wrong.

The practical consequence: do not rely on the session's felt sense to confirm a surgery took effect. Verify externally instead:

- the file's modification time on disk,
- the token count from `GET /contexts` (a sharp drop means the trim took, and `stale_reading` clears),
- and, if you want certainty, read a few records from the backup and confirm that detailed verbatim from the cut period is genuinely gone while the recap's themes are present.

The seamlessness is the design working as intended. It is also a blind spot. Trust the external signals.
