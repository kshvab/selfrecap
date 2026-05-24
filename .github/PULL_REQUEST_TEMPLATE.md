## What this changes

Brief description of the change and why.

## Type

- [ ] Bug fix
- [ ] New feature
- [ ] Docs
- [ ] Refactor / internal
- [ ] Security

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] New behavior has tests (especially anything touching `/surgery` or path resolution)
- [ ] No real paths, session IDs, or secrets in code, tests, or docs
- [ ] Docs updated if the API surface or config shape changed

## Surgery / security note

If this touches `src/lib/surgery.ts`, `src/config.ts` (path resolution), or the auth layer in `src/server.ts`: describe how you verified the safety invariants still hold (path traversal rejected, backups written, pair-balance preserved, auth enforced).
