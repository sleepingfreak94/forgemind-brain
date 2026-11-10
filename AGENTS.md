# forgemind-brain

Local memory for coding agents. TypeScript, Node >= 26.7 (`node:sqlite`), no runtime dependencies.

- Build: `npm run build`. Test: `npm test` (it builds first).
- Brain data lives in `~/.forgemind`. Never commit it. Tests must use temp directories.
- Keep the guarantees: owner approval before lessons guide agents, secret refusal or redaction,
  0700/0600 permissions, the context size caps, and workspace path checks.
- No new dependencies without the maintainer's approval. Files under 300 lines.
- Commits: `type(scope): description`. Work on `task/*` branches and open draft PRs. Never push to `main`.
- Reference docs: [docs/brain.md](docs/brain.md). Keep README, docs and code in sync.
