# mcp/term-local

Local process execution MCP server.

## Tools

| Tool | Description |
|------|-------------|
| `bash` | `{ script, cwd?, timeout? }` — real host bash (full shell, real filesystem) |
| `exec` | `{ command, args[], cwd?, timeout? }` — host program with argv, no shell |

Stdout and stderr are merged in arrival order. Exit 0 returns the merged
output (or `(no output)`). Non-zero exit / timeout / abort throw with Pi
`appendStatus` text (`Command exited with code N`, etc.). Output is tail-truncated
to 2000 lines / 50KiB; full output spills under `.angela/tmp/` when truncated.

Both tools run as the MCP server's user on the **host** — there is no
sandbox or overlay. `bash` is for shell work (pipes, conditionals, globs);
`exec` is for running a specific program with exact argv.

Progress: MCP `notifications/progress` with `{ progressToken, output }`.

Cancel: MCP `notifications/cancelled` with `{ requestId }` (Stop / new prompt)
aborts the matching in-flight `tools/call`, SIGTERM then SIGKILL the child,
and returns `Command aborted`. `abortAllTermLocal()` kills every tracked child.

## Env

- `MCP_TERM_CWD` — default working directory for `bash`/`exec`
- `MCP_TERM_JB_ROOT` — legacy fallback root (used only when `MCP_TERM_CWD`
  is unset); kept for existing configs that only set it
- `MCP_TERM_PATH` — PATH override for spawned processes
- `MCP_TERM_ENV` — extra `KEY=VALUE` env (JSON object or newline/comma
  separated); other keys override the host environment
- `MCP_TERM_ALLOW` — comma-separated regexes; if set, the command line must
  match one of them (opt-in restriction)

## Run

From the monorepo root:

```bash
bun ./term-local/server.mjs
```

With an allowlist:

```bash
MCP_TERM_ALLOW='echo,ls,pwd' bun ./term-local/server.mjs
```
