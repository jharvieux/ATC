# Claude Code — per-developer setup

`.claude/settings.json` is gitignored (see `.gitignore` line 43) because it
mixes team-shared automation with per-user state (plugins, permission
allowlists, MCP server tokens). The shared assets — slash commands, hooks,
subagents, skills — live under tracked directories (`commands/`, `hooks/`,
`agents/`, `skills/`) and need to be wired in once per developer.

This runbook is the wire-up steps.

## Required

Paste the following into your local `.claude/settings.json` (create it if
absent, or merge under existing keys):

```jsonc
{
  "enabledPlugins": {
    "frontend-design@claude-plugins-official": true
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/block-spec-memory-edits.mjs\""
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/lint-changed-file.mjs\""
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/typecheck-changed-workspaces.mjs\""
          }
        ]
      }
    ]
  }
}
```

### What this gives you

- **`block-spec-memory-edits` PreToolUse hook** — blocks Edit/Write on
  `specs/**` (read-only source of truth per CLAUDE.md) and blocks
  modifications to prior MEMORY.md entries (history is append-only).
  Fails closed on parse/read errors.
- **`d091-reviewer` subagent** (auto-discovered from `.claude/agents/`) —
  read-only auditor for the D-091 anti-patterns documented in CLAUDE.md.
  Invokable explicitly ("have d091-reviewer audit my changes") or
  proactively by the main Claude session before commits/PRs.
- **`lint-changed-file` PostToolUse hook** — runs eslint on every
  TS/TSX edit in `apps/main` or `apps/rag` (~0.8s). Exit 2 surfaces lint
  errors to the agent so they get fixed in-loop instead of at CI. Skips
  test directories, generated output, and files outside the two apps.
- **`typecheck-changed-workspaces` Stop hook** — runs `tsc --noEmit` at
  turn-end on any workspace with uncommitted TS changes (~45s per
  workspace). Skips entirely if `git status` shows no TS changes (most
  turns). Catches the next category up from lint: type drift, missing
  exports, broken import paths. Exit 2 prompts Claude to address before
  the next turn.

## Optional MCP servers

The two project Supabase databases are accessible via read-only MCP servers
if you've configured a personal access token. Each developer wires their
own — tokens stay in `~/.claude.json`, not in this repo.

Generate a PAT at <https://supabase.com/dashboard/account/tokens>, then:

```bash
# RAG db
claude mcp add supabase-rag --scope user -- \
  npx -y @supabase/mcp-server-supabase@latest \
  --read-only --project-ref=jjznkprbotkqqnuvcost --access-token=<PAT>

# Main db
claude mcp add supabase-main --scope user -- \
  npx -y @supabase/mcp-server-supabase@latest \
  --read-only --project-ref=mfaknjyqiwcjojukcnea --access-token=<PAT>
```

Both stay `--read-only` to honor the CLAUDE.md rule against prod writes.

Restart Claude Code after `claude mcp add` so the tools register.

## Verifying the hook is active

After wiring it up, in any Claude Code session:

```bash
echo '{"tool_name":"Edit","tool_input":{"file_path":"'"$CLAUDE_PROJECT_DIR"'/specs/foo.md","old_string":"a","new_string":"b"}}' \
  | node "$CLAUDE_PROJECT_DIR/.claude/hooks/block-spec-memory-edits.mjs"; echo "exit: $?"
```

Expected output: a `BLOCKED:` message and `exit: 2`. If you get `exit: 0`,
the hook isn't taking the input correctly — check that `node` resolves and
the path is right.
