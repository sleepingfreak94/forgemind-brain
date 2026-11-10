# Migrating from the ForgeMind harness

Older versions kept the brain at `~/.forgemind/brain/personal/brain.sqlite` (plus `company/`, which is never read). Until you migrate, opening the brain with the new code fails with `legacy brain found; run npm run brain -- migrate after switching all configs`; it will not silently start an empty brain. Close or restart all open Claude Code, Cursor and Codex sessions before running migrate (already-open sessions keep writing to the old file). Do these in order:

1. `npm run install-local`
2. Switch ALL configs to `~/.forgemind/bin/`: Claude Code MCP and hooks, Cursor `mcp.json` and `hooks.json`, and Codex `config.toml`. Do this before step 3 so no old tool is still writing to the old file.
3. `npm run brain -- migrate`. It refuses (exit 2) if `~/.forgemind/brain.sqlite` already exists. Otherwise it snapshots the old file (a hot journal is rolled back first), checks integrity, sets mode `0600`, publishes it without replacing anything, and prints the entry and history counts. A stray `.brain.migrating-*` file left by a crashed migrate is removed by the next migrate run; if it makes the brain refuse to open (`unsafe memory storage`), the error names it and it is safe to delete.
4. Verify with `npm run brain -- list --workspace /path/to/project` and `history`.

The old file is kept. Only a hot journal may be rolled back (normal SQLite recovery); its data is otherwise not changed. The two files do not sync: anything written to the old one after the migration is not seen by the new brain. Delete the old `brain/` folder yourself when you are happy. The first time the new code opens the file it upgrades the schema in place to version 4: the history table is rebuilt if needed so `codex` entries fit (version 3), and gains the `attachments` column (version 4).

After migrating, follow [Upgrading](brain.md#upgrading) for later updates.
