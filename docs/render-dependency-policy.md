# Render dependency installation policy

This repository currently does not include a `package-lock.json` file.

Until a lockfile is committed, GitHub Actions and Render services must use:

```bash
npm install --no-audit --no-fund
```

Do not use `npm ci` or `actions/setup-node` with `cache: npm` without a committed npm lockfile. Both require lockfile metadata and will fail before tests or deployment begin.

A future dependency-hardening change should generate and commit `package-lock.json`, then switch CI and Render back to `npm ci` for reproducible builds.
