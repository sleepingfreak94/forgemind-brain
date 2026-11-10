# forgemind-brain

Local memory for AI coding agents. Claude Code, Cursor and Codex share one brain
on your machine (`~/.forgemind`), so each new session knows what was done, what
worked and what failed in a project. The data is never stored in git.

```
npm ci
npm test
npm run brain -- list --workspace /path/to/project
```

Setup and commands: [docs/brain.md](docs/brain.md). Planned changes: [docs/plan.md](docs/plan.md).
