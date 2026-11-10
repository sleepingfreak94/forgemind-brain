# Central brain: owner guide

The brain holds reviewed knowledge (conventions, lessons, decisions, patterns). It is local owner state in `~/.forgemind/brain`, never in a repository.

## Spaces

There are two isolated spaces, `personal` and `company`, each with its own database. Every project uses the shared default `personal` space automatically, with no setup. `brain map --workspace P --space company` is optional and keeps a project apart from the shared space. An explicit mapping is permanent: remapping to the other space is refused ("already mapped"). Data already written to the default space does not move when you map later. The space always comes from the map (or the default); commands have no space option except `map`. Concurrent `map` calls are not locked (last writer wins).

## Commands

```
npm run brain -- map --workspace /path/to/project --space company   # optional
npm run brain -- add --workspace /path/to/project --kind convention --text "PR titles use type(scope): summary." --reason "owner" [--evidence E] [--scope project|space]
npm run brain -- list --workspace /path/to/project [--status proposed]
npm run brain -- show --workspace /path/to/project --id ID
npm run brain -- approve --workspace /path/to/project --id ID
npm run brain -- reject --workspace /path/to/project --id ID [--note N]
npm run brain -- retire --workspace /path/to/project --id ID
npm run brain -- learn --workspace /path/to/project [--source git|github|all] [--limit N]
npm run brain -- history --workspace /path/to/project [--limit N]
```

All commands accept `--brain-dir` (default `~/.forgemind/brain`). `--scope project` (default) limits an entry to the project; `--scope space` makes it space-wide.

## Lifecycle

New entries are `proposed`. You `approve` or `reject` them; an approved entry can later be `retire`d. Proposed, rejected and retired items never guide agents; only approved entries are used. Text that looks like a secret is refused.

## Learning from history

```
npm run brain -- learn --workspace /path/to/project --source all --limit 100
```

`learn` reads the git log and remote branch names, and merged pull requests through `gh`. It creates only `proposed` entries scoped to the project; you still `approve` or `reject` each one. Proposal text is generated from statistics (for example "4 of 5 commits"), never copied from commit, PR or review text, and evidence holds only identifiers (`git:<hash>`, `branch:<prefix>`, PR URLs). The command prints `{"proposed": [ids], "skipped": [sources]}`; a source that fails (for example `gh` not signed in) is listed in `skipped` and does not stop the others.

## Run history

History is facts, not rules, and never needs approval. Every harness run records its title, summary, files, outcome and evidence automatically in the project's space (the default unless mapped); the run prints `Brain: run not recorded (...)` only on errors. Secret-like values are stored as `[redacted]`. `history` lists the newest runs for the project (`--limit` 1 to 200, default 20). History never appears in `list` or guides agents.

## The harness learns

`project:run` loads the same `brain_context` packet (at most 3200 characters, marked untrusted evidence) into the plan, coding and review prompts and saves it as `brain-context.json`. It prints `Brain: context loaded` or `Brain: context not loaded`; a load failure never stops the run.

After each run, failed checks, revise or blocked review findings and the stop reason become `proposed` lessons scoped to the project (at most 3 + 3 + 1; secret-like text is skipped; the same run never duplicates them). They stay proposed until you `approve` them (`npm run brain -- approve`), and only approved lessons reach the next run's context.

## Use from Claude Code and Cursor

`forgemind-brain` is a local MCP server over stdio. Run `npm run build` first, and register `node` directly (not `npm run`, whose banner would corrupt the JSON-RPC stream).

In the examples below, replace /absolute/path/to/forgemind with the absolute path of your ForgeMind checkout.

Claude Code:

```
claude mcp add --scope user forgemind-brain -- node /absolute/path/to/forgemind/dist/src/memory/brain-mcp.js --source claude-code
```

Cursor, in `~/.cursor/mcp.json`:

```
{"mcpServers":{"forgemind-brain":{"command":"node","args":["/absolute/path/to/forgemind/dist/src/memory/brain-mcp.js","--source","cursor"]}}}
```

For the Cursor CLI, allow these four tools in the `permissions.allow` list of `~/.cursor/cli-config.json`:

```
Mcp(forgemind-brain:brain_context)
Mcp(forgemind-brain:brain_search)
Mcp(forgemind-brain:brain_record)
Mcp(forgemind-brain:brain_propose)
```

The file is ~/.cursor/cli-config.json; keep any entries already there.

Options: `--source claude-code|cursor` (required), `--workspace` (default current directory, resolved to its git top-level), `--brain-dir`.

Tools: `brain_context` (project packet), `brain_search` (query, optional limit 1 to 5), `brain_propose` (kind, text, reason; stays `proposed` until you approve it), `brain_record` (title, summary, files, outcome; once per distinct summary per day).

Token caps: `brain_context` is at most 3200 characters (about 800 tokens), dropping the oldest items first and ending with `(N more; use brain_search)`. `brain_search` returns at most 5 items, 400 characters each and 2000 in total. Agents never get the whole store and never read the database.

Agents should call `brain_context` at the start of a session and `brain_record` at the end.

## Automatic capture and recall (hooks)

Hooks close the memory loop in your own Claude Code and Cursor sessions. Run `npm run build` first.

Claude Code, in `~/.claude/settings.json`:

```
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node /absolute/path/to/forgemind/dist/src/memory/brain-hook.js session-start --source claude-code"}]}],"SessionEnd":[{"hooks":[{"type":"command","command":"node /absolute/path/to/forgemind/dist/src/memory/brain-hook.js session-end --source claude-code"}]}]}}
```

Cursor, in `~/.cursor/hooks.json`:

```
{"version":1,"hooks":{"sessionStart":[{"command":"node /absolute/path/to/forgemind/dist/src/memory/brain-hook.js session-start --source cursor"}],"sessionEnd":[{"command":"node /absolute/path/to/forgemind/dist/src/memory/brain-hook.js session-end --source cursor"}]}}
```

Session start injects the `brain_context` packet (at most 3200 characters) plus a reminder to call `brain_record` before finishing. Session end records one fallback fact per session (key `session:<id>`): the title comes from the first user prompt, files come from `git status`, secret-like values become `[redacted]`, and nothing is recorded when there is no prompt and no change. The session's own agent writes the rich summary through `brain_record`.

Hooks never call a model. Errors go to stderr as one line; the hook always exits 0 and never blocks a session. History facts are recalled at once; rules still wait for your approval.

To remove the hooks, delete the `SessionStart` and `SessionEnd` entries from `~/.claude/settings.json` and the `sessionStart` and `sessionEnd` entries from `~/.cursor/hooks.json` (or the files, if they hold nothing else). Existing history stays in the brain.

## Output

Every command prints one JSON object. Exit codes: 0 success, 1 failure, 2 usage error.
