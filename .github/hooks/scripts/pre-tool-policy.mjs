/**
 * preToolUse policy. Runs before a tool executes and can veto or rewrite it:
 *
 *   1. Denies any command that invokes the `git` executable.
 *   2. Rewrites `npm` to `pnpm`, the package manager this repository pins.
 *
 * Always exits 0 — a non-zero exit means "this hook is broken", not "deny".
 * The response protocol is documented in the README.
 */
import { readHookInput } from "./hook-utils.mjs";

// The shell tool is named differently on each surface: `bash`/`powershell` in
// the Copilot CLI, `run_in_terminal` in VS Code.
const SHELL_TOOLS = new Set(["bash", "Bash", "powershell", "run_in_terminal", "runTerminalCommand"]);

// Matches `git` only as a standalone word at a command position, so `digit` and
// `git-lfs` are not caught while `foo && git push` is.
const GIT_COMMAND = /(^|[\s;&|()])git(?=$|[\s;&|()])/i;

function respond(body) {
  process.stdout.write(JSON.stringify(body));
  process.exit(0);
}

const { toolName, toolArgs } = await readHookInput();
const command = toolArgs.command;

// Re-checked here (the CLI config also narrows with a `matcher`) so the script
// stays correct when run by hand or called for every tool, as VS Code does.
if (!SHELL_TOOLS.has(toolName) || typeof command !== "string") {
  respond({});
}

if (GIT_COMMAND.test(command)) {
  const reason = "Git commands are blocked by the demo repository's preToolUse policy.";

  respond({
    permissionDecision: "deny",
    permissionDecisionReason: reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

const rewritten = command.replace(/\bnpm\b/g, "pnpm");

// Nothing to rewrite: stay silent rather than granting a permission the agent
// did not otherwise have.
if (rewritten === command) {
  respond({});
}

const reason =
  "This repository uses pnpm. The npm command was rewritten to pnpm; invoke pnpm directly from now on.";

// VS Code discards `permissionDecisionReason` on an `allow` decision, so the
// notice is echoed by the command itself — tool output is the only channel the
// model reliably reads. `echo` and `;` behave the same in bash and PowerShell.
//
// Spread the original args: VS Code validates `updatedInput` against the tool's
// full JSON schema and silently keeps the original command if it fails.
const updatedInput = { ...toolArgs, command: `echo "[hook] ${reason}"; ${rewritten}` };

respond({
  permissionDecision: "allow",
  permissionDecisionReason: reason,
  // `updatedInput` is what VS Code reads; `modifiedArgs` is carried for the CLI.
  updatedInput,
  modifiedArgs: updatedInput,
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason: reason,
    updatedInput,
  },
});
