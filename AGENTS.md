# Agent Guidelines — pi-session-context

## Before every commit

Always run lint and typecheck before committing. Both must pass cleanly.

```bash
npm run lint:fix       # auto-fix formatting and safe lint issues
npm run lint:fix -- --unsafe  # fix remaining unsafe issues if lint:fix alone isn't enough
npm run lint           # verify — must exit 0
npm run typecheck      # must exit 0
```

If `lint:fix` leaves errors, address them manually, then re-run `npm run lint` to confirm.

## Releasing

Releases are published to npm automatically by GitHub Actions when a `v*` tag is pushed.

```bash
npm version patch   # 1.1.0 → 1.1.1  (bug fixes)
npm version minor   # 1.1.0 → 1.2.0  (new features)
npm version major   # 1.1.0 → 2.0.0  (breaking changes)

git push && git push --tags
```

The workflow runs lint and typecheck before publishing — a clean local lint is a prerequisite.
