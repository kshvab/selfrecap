# Contributing to selfrecap

Thanks for your interest. This is a small, focused TypeScript server, and contributions that keep it small and focused are the most welcome. Because the tool rewrites files, correctness and tests matter more than feature breadth.

## Development setup

Requirements: Node.js >= 20.

```bash
git clone https://github.com/kshvab/selfrecap.git selfrecap
cd selfrecap
npm install
cp config.example.yaml config.yaml
# edit config.yaml to point at a real (or fixture) JSONL session
npm run dev    # server with auto-reload (tsx watch)
```

`config.yaml` is git-ignored — your local paths never get committed.

Useful scripts (see `package.json`):

- `npm start` — run the server
- `npm run dev` — run with reload on change
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — run the test suite (Vitest)
- `npm run test:watch` — tests in watch mode
- `npm run build` — compile to `dist/`
- `npm run check-config` — validate `config.yaml`

## Project layout

```
src/
  server.ts            Fastify app, security hook, route registration, /health and /voices
  config.ts            config.yaml loader, path resolution + allowed_roots guard, restart checks
  version.ts
  routes/              one file per HTTP route
    find-cut-point.ts  context.ts  contexts.ts  recap-plan.ts  records.ts  lifecycle.ts  surgery.ts
  lib/                 the engine
    jsonl.ts           record parsing (and exact-bytes reading for surgery), text extraction
    recaps.ts          the one definition of a recap: sentinel parsing, the recap stack, numbering
    finder.ts          cut-point search algorithms, records around a line
    monitor.ts         context-size computation
    continuation.ts    following continued-in markers to the live session file
    recap-plan.ts      the recap plan and headroom
    surgery.ts         cut + inject + re-parent, the safety checks, the swap under a live session
    backups.ts         verified backups and their rotation
    fsutil.ts          durable writes, range reads
    sessions.ts        Claude Code's live-session registry (Windows liveness)
    lifecycle.ts       process handling for selfrecap restart (Windows)
    lifecycle-log.ts   nudge/restart events
    nudger.ts          the context nudge (Windows, opt-in)
    account-usage.ts   plan-usage bars (opt-in)
scripts/
  recap.ts             the CLI a session drives the recap cycle with
  selfrecap.ts         selfrecap restart / log (Windows)
  check-config.ts      validate config.yaml
  install-skill.ts     install the /remember skill into each account
tests/                 Vitest tests + JSONL fixtures
docs/                  protocol, walkthrough, and field-note guides
```

## How to add a route

1. Create `src/routes/your-route.ts` exporting a `registerYourRoute(app, config)` function. Follow the existing routes as a template:
   - Validate the request body with a Zod schema and return `400 { error: "invalid_request", details }` on failure.
   - Resolve the target file with `resolvePath(config, voice, file_path)` from `src/config.ts`; return `400 { error: "path_resolution_failed", message }` on failure.
   - Keep the heavy lifting in a `src/lib/` function so it can be unit-tested independently of HTTP.
2. Register it in `src/server.ts` alongside the existing `register*` calls.
3. Add tests under `tests/` against the JSONL fixture.
4. Update the API surface section of `README.md` and, if you change the record or sentinel shape, `docs/protocol.md`.

## Testing

```bash
npm test
```

The suite runs against hand-crafted JSONL fixtures in `tests/`. When you touch `lib/surgery.ts` or `lib/finder.ts`, add cases that pin the behavior — especially the safety invariants (cut target must exist, sentinel required, prior recaps preserved, chain reaches the recap, no split tool call, pair balance, path-allowlist rejection) and the swap under a live session (the `hooks` test seams in `SurgeryRequest`). For a file-mutation tool, regression coverage is the price of admission for changes to the engine.

## Pull request conventions

- Keep PRs focused — one logical change per PR.
- Run `npm run typecheck` and `npm test` before pushing; both must pass.
- Write a clear description: what changed and why. Link any related issue.
- If you add or change an endpoint, update `README.md` and `docs/protocol.md` in the same PR.
- Do not commit `config.yaml`, real transcript files, backups, or anything containing personal paths or session IDs.
- New behavior needs a test. Bug fixes should include a test that fails before the fix.

## Code style

- TypeScript, strict mode (see `tsconfig.json`), ESM imports with `.js` extensions on local paths.
- No em-dashes inside fenced code or config blocks — some parsers choke on them. Prose em-dashes are fine.
- Prefer small pure functions in `lib/` over logic embedded in route handlers.

## Code of conduct

Participation is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md).
