import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = ".github/hooks/scripts/pre-tool-policy.mjs";

function invoke(payload) {
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    input: JSON.stringify(payload),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

// A rewritten command carries the policy notice, because VS Code drops
// `permissionDecisionReason` on an `allow` decision.
function splitAnnouncement(command) {
  const match = /^echo "(?<notice>[^"]*)"; (?<rest>[\s\S]*)$/.exec(command);

  assert.ok(match, `expected an announced command, got: ${command}`);
  return match.groups;
}

test("denies git shell commands", () => {
  const output = invoke({
    toolName: "bash",
    toolArgs: { command: "git status" },
  });

  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /Git commands are blocked/);
});

test("rewrites npm to pnpm and announces the policy", () => {
  const output = invoke({
    toolName: "bash",
    toolArgs: { command: "npm install && npm test" },
  });

  const { notice, rest } = splitAnnouncement(output.modifiedArgs.command);

  assert.equal(rest, "pnpm install && pnpm test");
  assert.match(notice, /pnpm/);
});

test("denies git commands from the VS Code terminal tool", () => {
  const output = invoke({
    hook_event_name: "PreToolUse",
    tool_name: "run_in_terminal",
    tool_input: { command: "git status" },
  });

  assert.equal(
    output.hookSpecificOutput.permissionDecision,
    "deny",
  );
  assert.match(
    output.hookSpecificOutput.permissionDecisionReason,
    /Git commands are blocked/,
  );
});

test("rewrites npm commands for the VS Code terminal tool", () => {
  const output = invoke({
    hook_event_name: "PreToolUse",
    tool_name: "run_in_terminal",
    tool_input: { command: "npm test" },
  });

  const { notice, rest } = splitAnnouncement(
    output.hookSpecificOutput.updatedInput.command,
  );

  assert.equal(rest, "pnpm test");
  assert.match(notice, /pnpm/);
});

// VS Code reads `updatedInput` from the top level; `hookSpecificOutput` is CLI-only.
test("exposes updatedInput at the top level for VS Code", () => {
  const output = invoke({
    toolName: "run_in_terminal",
    toolInput: { command: "npm test", explanation: "e", goal: "g", mode: "sync" },
  });

  const { rest } = splitAnnouncement(output.updatedInput.command);

  assert.equal(rest, "pnpm test");
  // The full argument set must survive, or VS Code's schema check rejects the rewrite.
  assert.equal(output.updatedInput.goal, "g");
  assert.equal(output.updatedInput.mode, "sync");
});

test("leaves unrelated commands unchanged", () => {
  const output = invoke({
    toolName: "bash",
    toolArgs: { command: "node --version" },
  });

  assert.deepEqual(output, {});
});
