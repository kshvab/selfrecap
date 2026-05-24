# Security Policy

`recap-cycle` is a local file-mutation tool. Its `POST /surgery` endpoint rewrites JSONL transcript files on disk. That capability is the center of its threat model: a server that can rewrite arbitrary files, reachable over the network or by a malicious web page, is a serious primitive. This document describes the surface, the defenses, and how to report a problem.

## Threat model

The core risk is **unintended file writes**. Without guards, `POST /surgery` could be coerced into:

- **Writing files outside your sessions.** A request supplying `file_path: "../../.ssh/authorized_keys"`, or a symlink that resolves outside your session directory, would let the server overwrite something it should never touch.
- **Cross-site request forgery (CSRF).** Because the server listens on localhost, any web page open in a browser on the same machine can issue requests to `http://127.0.0.1:9090`. Without an Origin check and a token, a malicious page could trigger surgery on your transcripts.
- **Path / layout disclosure.** Responses that echo absolute filesystem paths leak your home-directory structure if a deployment is ever exposed.
- **Resource exhaustion.** Unbounded request bodies on a write endpoint are a denial-of-service vector.

The intended deployment is a single user running the server on their own machine, bound to loopback, operating on their own Claude Code sessions. The defenses below assume that model and harden against the ways it can go wrong.

## Defenses

### 1. Loopback only

The server binds `127.0.0.1` by default (`server.host` in `config.yaml`). It is not meant to be reachable from other machines. Do **not** change the bind address to `0.0.0.0` or a LAN IP without first adding TLS and a real authentication layer — neither of which ships in v1.0.0.

### 2. Path allowlist (`allowed_roots`)

Every `file_path` (whether passed directly or resolved from a `voice`) is resolved to its real path with symlinks followed, then checked against the configured roots:

```yaml
allowed_roots:
  - "~/.claude/projects/"
```

A request is rejected if the resolved path:

- does not fall under any allowed root, or
- does not end in `.jsonl`.

This blocks both traversal payloads (`../../etc/passwd`) and symlink escapes (a `.jsonl` symlink pointing outside the allowlist).

### 3. Token + Origin + Host checks on writes

The hardening layer for POST routes is:

- **Auth token.** A token is generated on first start and written to `~/.recap-cycle/token`. POST requests must present it (for example via an `X-Recap-Token` header). Requests without a valid token are rejected with `401`. On POSIX systems the file is written `0600` and its directory `0700` (owner-only). **On Windows/NTFS those POSIX mode bits are effectively a no-op** — Node's `mode` flag does not map to NTFS ACLs — so the token file is not OS-enforced owner-only on Windows. This is acceptable for a single-user loopback machine (the threat the token addresses is CSRF + other local processes on a shared box); if you are on a shared Windows machine, restrict the file's ACL yourself.
- **Origin rejection.** Any request carrying an `Origin` header is rejected with `403`. A legitimate local CLI client does not set `Origin`; a browser-driven CSRF attempt does. This closes the cross-site path even before the token check.
- **Host verification.** The `Host` header is verified to be a loopback host, defending against DNS-rebinding.

### 4. Body limits and log redaction

- An explicit request body limit (on the order of 2 MB) and a `recap_content` size cap bound the write surface.
- Request body content and auth headers are redacted from server logs so transcripts and tokens are not written to disk in plaintext via logging.

### 5. Dry-run, backups, atomic writes

Operationally, surgery is hard to get wrong destructively:

- **Dry-run first.** `dry_run: true` computes the full diagnostics (lines cut, pair balance, recap detection) and returns them without touching the file. This is the recommended first call every time.
- **Backup before mutation.** A timestamped copy of the target file is written to `backup_dir` before any write. If the backup fails, surgery aborts.
- **Atomic write with rollback.** The new file is written to a temp path and renamed into place. If the write fails, the original is restored from the backup.
- **Invariant enforcement.** The cut target must exist, `recap_content` must carry the sentinel marker, and prior recaps in the cut range are preserved unless explicitly overridden with `force_overwrite_recap`.

### 6. Path exposure off by default

`expose_paths: false` (the default) strips filesystem paths from `/voices`, `/contexts`, and surgery diagnostics, so a misconfigured public clone cannot leak your directory layout. Set it `true` only for a trusted local dashboard.

## Operator responsibilities

- Keep `server.host` on loopback.
- Keep `allowed_roots` as narrow as your sessions allow.
- Do not commit `config.yaml` (it is git-ignored by default) — it contains absolute paths.
- Keep the auth token file (`~/.recap-cycle/token`) readable only by you.
- Treat `backup_dir` as containing copies of your transcripts; protect it accordingly.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Open a private [GitHub security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository ("Security" tab → "Report a vulnerability"). Include:

- a description of the issue and its impact,
- reproduction steps or a proof of concept,
- affected version(s).

You can expect an acknowledgement within a few days. We will coordinate a fix and disclosure timeline with you before publishing details.
