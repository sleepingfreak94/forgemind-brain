# forgemind-brain

**Local memory for AI coding agents.** Claude Code, Cursor and Codex share one
brain on your machine. Each new session knows what was done in a project, what
worked and what failed, without you re-explaining it.

- **Private by design:** one SQLite file in `~/.forgemind`. It is never in git,
  never uploaded, and has no cloud service and no telemetry.
- **You stay in control:** agents can *propose* lessons. A lesson guides future
  sessions only after you approve it, so wrong guesses don't pile up.
- **Works across tools:** a lesson approved while you use Cursor is there the next time
  you open Claude Code.
- **Small:** about 1,100 lines of TypeScript. The only runtime is Node.js, with no
  other dependencies.

## How it works

```
 Claude Code ─┐                         ┌─ lessons, conventions, decisions (you approve)
 Cursor ──────┼── MCP + hooks ──► brain.sqlite ─┼─ session history (what was done, outcome)
 Codex ───────┘                         └─ attachments (screenshots, PDFs)
```

1. **Session start:** a hook loads a short, size-capped packet into the agent's
   context. It holds the approved lessons for this project and recent history.
2. **During work:** the agent can search the brain, record what it did, attach
   screenshots (for example from a bug bash) and propose new lessons.
3. **Session end:** a hook records a fallback summary (first prompt, changed files and the first line of the agent's last reply as the outcome),
   so nothing is lost if the agent forgets.
4. **Reflect:** say "reflect" in any tool to review recent sessions in-chat (`brain_reflect_packet`), or schedule it in the background; see `docs/brain.md`.
5. **You review:** `npm run brain -- list --workspace <project> --status proposed`, then `approve` or
   `reject`.

**Obsidian view:** `npm run brain -- export --obsidian` writes a read-only vault, so Obsidian's graph shows projects, sessions, ADRs, recipes and lessons ([docs](docs/brain.md#obsidian-view)).

The server also tells agents to record a short summary after they read tickets,
chats or email (Jira, Slack, Teams, Outlook) through your other MCP connectors.
The summary holds decisions, outcomes and IDs; raw message content is never pasted. That way
what an agent learned there is not lost when the session ends.

## Quick start

Requires Node.js 26.7 or newer (it uses the built-in `node:sqlite`). Tested on macOS.

```sh
git clone https://github.com/sleepingfreak94/forgemind-brain.git
cd forgemind-brain
npm ci
npm run install-local   # builds and installs to ~/.forgemind/bin
```

Connect Claude Code:

```sh
claude mcp add --scope user forgemind-brain -- node ~/.forgemind/bin/brain-mcp.js --source claude-code
```

Then add the [session hooks](docs/brain.md#hooks-claude-code-cursor-and-codex) so memory
loads and saves automatically.

Connect Cursor: add the server to `~/.cursor/mcp.json`, the hooks to
`~/.cursor/hooks.json`, and, for the Cursor CLI, allow all eight brain tools in
`~/.cursor/cli-config.json` (`brain_context`, `brain_search`, `brain_record`,
`brain_propose`, `brain_adr`, `brain_recipe`, `brain_doc`, `brain_reflect_packet`).
Exact snippets for Cursor and Codex are in [docs/brain.md](docs/brain.md#set-up-the-tools).

Try it in any project:

```sh
npm run brain -- add --workspace ~/code/my-app --kind lesson \
  --text "Run e2e tests with --workers=1; parallel runs flake on CI." --reason "seen twice"
npm run brain -- list --workspace ~/code/my-app --status proposed
npm run brain -- approve --workspace ~/code/my-app --id <id>
```

The next agent session in `~/code/my-app` starts with that lesson in its context.

## What gets stored

| Kind | Example | Needs approval |
|---|---|---|
| `lesson` | "Mocking the clock broke the retry test; use fake timers." | yes |
| `convention` | "Commit subjects follow type(scope): description." | yes |
| `decision` | "We chose SQLite over Postgres for local state." | yes |
| `pattern` | "API handlers validate input at the boundary." | yes |
| history | "Fixed login redirect: worked; tried cookie fix first: failed." | no (facts) |
| attachment | screenshot of the bug, before and after | no |

Text that looks like a secret (API keys, tokens, passwords) is refused or
redacted. Agents never read the database directly: they get at most 3,200
characters of context and 5 search results at a time.

## Learn from an existing repo

```sh
npm run brain -- learn --workspace ~/code/my-app --source all
```

This reads the git log, branch names and merged PRs (via `gh`), then proposes
conventions it finds, such as "commit subjects follow type(scope)". They wait for your approval.

## Docs

- [docs/brain.md](docs/brain.md): full reference covering commands, tool setup, hooks,
  attachments and limits.
- [docs/migrating-from-forgemind.md](docs/migrating-from-forgemind.md): only
  for users of the old ForgeMind harness.

## Contributing

Issues and PRs are welcome. Run `npm test` before you open a PR. See
[AGENTS.md](AGENTS.md) for the rules agents and humans follow in this repo.

## License

[MIT](LICENSE)
