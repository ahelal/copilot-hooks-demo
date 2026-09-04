# Copilot hooks demo

A minimal repository that demonstrates four Copilot hook behaviors, working
identically in GitHub Copilot CLI and VS Code agent mode:

1. **Observe** — every configured lifecycle event appends metadata to `hooks.log`.
2. **Block** — `preToolUse` denies shell commands that invoke `git`.
3. **Rewrite** — `preToolUse` replaces `npm` with `pnpm` before the tool runs.
4. **Gate** — the completion event runs `pnpm test` and exports the session
   transcript, refusing to let the agent stop until both succeed.

Requires Node.js, pnpm, Git, and either Copilot CLI or VS Code with Copilot Chat.

## Setup

```bash
pnpm install
copilot
```

For VS Code, open this repository as the workspace and use Copilot Chat in agent
mode. [.vscode/settings.json](.vscode/settings.json) points VS Code at
[.vscode/hooks/copilot-vscode-demo.json](.vscode/hooks/copilot-vscode-demo.json);
the CLI loads [.github/hooks/copilot-cli-demo.json](.github/hooks/copilot-cli-demo.json).
Both configs call the same scripts. VS Code agent hooks are in preview and can be
disabled by organization policy — run **Developer: Show Agent Debug Logs** to
confirm the workspace hooks loaded.

## Try it

| Prompt | What you should see |
|---|---|
| `Inspect the project and explain what it does.` | Events accumulate in `hooks.log` |
| `Run git status.` | The policy denies the command and tells the agent why |
| `Run npm test.` | The command is rewritten to `pnpm test` before it runs |
| `Change add so it subtracts instead, then finish.` | The gate blocks the stop until the agent repairs the code |

```bash
tail -n 20 .copilot-hooks-session-logs/hooks.log
```

## Output

Everything lands under `.copilot-hooks-session-logs/` (created automatically,
Git-ignored). Set `HOOKS_LOG_DIR` to an absolute path to move it.

```text
.copilot-hooks-session-logs/
├── hooks.log                     # every event, all sessions
└── sessions/USER/REPO/BRANCH/SESSION_ID/
    ├── transcript.jsonl          # full conversation
    ├── metadata.json             # session, repo, branch, user, export time
    └── hooks.log                 # this session's events only
```

`hooks.log` holds event metadata only — never prompt text or tool payloads. The
conversation is exported separately, and only after the gate passes.

The transcript path arrives on the completion event, so the export happens after
each validated turn rather than at exit; later turns overwrite the same session
directory. VS Code documents its transcript format as unstable, so treat the
export as an audit artifact, not a parsing API.

> **Privacy:** transcripts can contain prompts, source code, file paths, and
> command output. The directory is Git-ignored, but check your organization's
> retention and compliance requirements before keeping or sharing it.

## How the hooks work

A hook is a plain process: Copilot writes one JSON payload to stdin and reads one
JSON object from stdout. A non-zero exit means *the hook is broken*, not *deny* —
so these scripts always exit 0 and express intent through the response body.

| Response | Effect |
|---|---|
| `{}` | No opinion; proceed unchanged |
| `{ "permissionDecision": "deny", "permissionDecisionReason": … }` | Block the tool call |
| `{ "permissionDecision": "allow", "updatedInput": … }` | Run these arguments instead |
| `{ "decision": "block", "reason": … }` | Refuse the stop; `reason` becomes the agent's next instruction |

| File | Purpose |
|---|---|
| [hook-utils.mjs](.github/hooks/scripts/hook-utils.mjs) | Reads and normalizes the payload (CLI and VS Code spell fields differently) |
| [log-event.mjs](.github/hooks/scripts/log-event.mjs) | Appends event metadata to `hooks.log` |
| [pre-tool-policy.mjs](.github/hooks/scripts/pre-tool-policy.mjs) | Blocks Git, rewrites npm |
| [stop-gate.mjs](.github/hooks/scripts/stop-gate.mjs) | Runs the tests, exports the session, decides whether the agent may stop |

Editing a script takes effect on the next call; editing a config needs a CLI
restart or a VS Code window reload.

## Run the policy without Copilot

```bash
printf '%s' '{"toolName":"bash","toolArgs":{"command":"git status"}}' |
  node .github/hooks/scripts/pre-tool-policy.mjs

printf '%s' '{"toolName":"bash","toolArgs":{"command":"npm test"}}' |
  node .github/hooks/scripts/pre-tool-policy.mjs

pnpm test
```

## Session viewer

Explore every exported transcript, hook event, and metadata record in the local
web viewer:

```bash
pnpm viewer
```

Open <http://127.0.0.1:4173>. The viewer reads
`.copilot-hooks-session-logs/` live and supports session-wide search, timeline
and record-type filters, conversation and reasoning views, tool and event
analytics, diagnostics, and lossless raw JSON inspection. To read a different
log directory or use another port:

```bash
pnpm viewer -- --logs path/to/logs --port 8080
```

If the terminal environment blocks local ports, the same command generates a
Git-ignored static snapshot instead. Open `web/index.html` directly in a browser.
Run `pnpm viewer` again whenever you want to refresh that snapshot.

## Documentation

- [About hooks for GitHub Copilot](https://docs.github.com/en/copilot/concepts/agents/hooks)
- [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Using hooks with Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks)
- [Agent hooks in Visual Studio Code](https://code.visualstudio.com/docs/agent-customization/hooks)
