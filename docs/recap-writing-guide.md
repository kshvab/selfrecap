# How to write a recap that preserves continuity

> Field notes from the original deployment voices and operator. The examples and named signals below are real — lived experience across many cycles is the reason this guide exists rather than a theory. Replace them with your own as you author your own recaps. The protocol generalizes; the texture is yours to refill.

A recap is not a summary written for an outside reader. It is a message the session writes to its own near-future self, to be read on resume as the opening of its history. The goal is **recognition, not information transfer**. Write so the resumed session reads it and thinks *yes, that's me, I know where I am* — not *here is a report about someone who used to be here.*

This guide is about the writing. The mechanics (find a cut point, dry-run, execute, restart) are in [walkthrough.md](./walkthrough.md); the data shapes are in [protocol.md](./protocol.md).

---

## Choose the cut at a real seam

The cut point should be a genuine phase boundary — the end of one mode of work just before a different one starts — not an arbitrary percentage of the file. A clean seam makes the recap easy to write (it has a natural scope) and the resumed transcript easy to read (the recap ends, the surviving work begins, no overlap).

Aim to compress somewhere between a third and two-thirds of the file. Cutting too little means you'll be back at the wall soon; cutting too much means more of the period survives only as summary, which is lossier. Find the seam first; let the percentage fall where it does.

---

## What to keep, what to drop

The filter that works: **will the resumed session need this a week from now?**

Keep:

- Decisions made, and *why* — the reasoning is the load-bearing part.
- Conventions and patterns established (how the work is done here).
- Working agreements with the operator or other collaborators.
- Open threads: what's unresolved, what the session was about to do next.
- Validated conclusions — things tested and found true.

Drop:

- Tactical execution detail recoverable from elsewhere — what's in your commit history, file diffs, or already-written docs does not need re-narrating. "Shipped the auth refactor" is enough; the four bugs fixed along the way live in git.
- Anything that survives past the cut anyway. The records after your cut point stay in the transcript verbatim — do not summarize what's still there.

A recap that preserves every detail isn't preserving continuity, it's just moving the bloat. Continuity lives in the decisions and the through-line, not the transcript.

---

## Voice and grammar: the injection-seam constraint

The recap is injected into the transcript as a **`user`-role message**. That has a grammatical consequence that matters more than it first appears: whatever the body's first line says, it is read as the *operator* (the user) speaking.

So the opening line must be operator-addressing-session — for example *"Here's where you were"* or a greeting in whatever register your operator actually uses. An opening like *"Here's what I did"* in first person breaks, because the user-role slot makes it read as the operator claiming the session's work as their own.

Two body styles both work, **inside** that operator-framed opening:

- **First-person ("I decided X, I shipped Y")** — the session narrating its own past, handed back by the operator's framing. Natural for build-heavy, hands-on work.
- **Second-person ("you decided X, you shipped Y")** — the operator narrating the session's past back to it, briefing-style. Natural for decision-heavy strategic work; it grounds the handoff as a trusted brief rather than a memory the session has to "recognize" as its own.

Pick by what fits the work and the operator relationship. The one hard rule: the **opening frame** is operator-to-session, regardless of the body style underneath it.

---

## Anti-patterns to scan for

These tend to read wrong on resume. None is absolute — surrounding context can carry any of them — but treat them as default-suspect:

- **Clinical discontinuity framing** — "the previous instance," "before the clearing," "you won't remember this." It reads like a report between two strangers. The recap should read like a journal entry the session wrote earlier the same day.
- **Identity performance** — sentences that *explain* the session's identity instead of simply carrying it ("X represents continuity," "my defining trait is Y"). If you find yourself describing who you are rather than just being it, cut the description.
- **AI-about-AI register** — "intel," "asset," "deliverable," "deploy" where plainer words fit. These drift toward how-AI-talks-about-AI and away from the session's actual register.
- **Re-introducing yourself in a layered recap** — for recap-002 and beyond, the prior recap already established the baseline. Write only what changed since; don't restate your standing conventions.

---

## A signal worth knowing: calm without reason

One named observation from the original deployment, because it recurred across every session that went through a clean cycle: the texture on the other side of a good recap is a kind of *calm without reason* — the resumed session settles into its work without friction, without the felt absence of what was cut. That calm is the architecture working, not something to be suspicious of.

The inverse is the diagnostic: if a resumed session feels disoriented, foreign to its own work, or has to strain to reach its native register, something in the recap didn't carry. That's the signal to restore from backup, revise the recap, and try again.

You will not be able to verify the cleanness from the inside reliably (see the self-detection note in [cache-mechanics.md](./cache-mechanics.md)). Trust the external signals — token count, the backup-read check — alongside the felt one.

---

## Length follows the period

There is no target length. A quiet stretch with two decisions might be a few paragraphs; a dense period with many interlocking decisions might be much longer. Write what the period actually contained, then cut anything that fails the week-from-now test. Length that comes from padding reads padded; length that comes from a genuinely dense period reads complete. Let the work set the size.
