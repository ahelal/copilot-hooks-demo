/**
 * Completion gate for `agentStop` (CLI) and `Stop` (VS Code). The agent may only
 * finish a turn once `pnpm test` passes and the session transcript is exported.
 *
 *   { decision: "allow" }         -> the agent may stop
 *   { decision: "block", reason } -> the agent keeps working; `reason` is fed
 *                                    back to it as the next instruction
 *
 * Every path exits 0 on purpose. A non-zero exit is reported as a hook failure
 * rather than a block, which would let a failing turn end anyway.
 *
 * This event fires per completed turn, not once per process, so a long session
 * re-exports its transcript several times into the same directory.
 */
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readHookInput, resolveLogDir } from "./hook-utils.mjs";

const input = await readHookInput();

function finish(decision, reason) {
  const output = { decision, continue: true };

  if (reason) {
    output.reason = reason;
  }

  if (input.event === "Stop" && decision === "block") {
    output.hookSpecificOutput = { hookEventName: "Stop", decision, reason };
  }

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

// Truncated from the tail: the assertion that failed is at the end, and the text
// is injected into the agent's context, so it has to stay small.
function details(...parts) {
  return parts.filter(Boolean).join("\n").slice(-6000);
}

// Collapses anything unsafe for a path segment, so an email address or a branch
// named `feature/x` cannot escape the sessions tree.
function sanitize(value) {
  return (value || "unknown").toLowerCase().replace(/[^a-z0-9._@-]+/g, "-");
}

// Hook processes are not themselves passed through preToolUse, so this
// repository's Git ban does not apply recursively.
function git(...args) {
  const result = spawnSync("git", args, { cwd: input.cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

async function exportSession() {
  if (!input.transcriptPath) {
    throw new Error("The stop payload did not include a transcript path.");
  }

  const logDir = resolveLogDir(input.cwd);
  const repository = path.basename(input.cwd);
  const user = git("config", "user.email") || os.userInfo().username;
  // `git branch --show-current` is empty on a detached HEAD.
  const branch = git("branch", "--show-current") || "detached";
  const segments = [user, repository, branch, input.sessionId].map(sanitize);
  const sessionDir = path.join(logDir, "sessions", ...segments);

  await mkdir(sessionDir, { recursive: true });
  await copyFile(input.transcriptPath, path.join(sessionDir, "transcript.jsonl"));

  const metadata = {
    sessionId: input.sessionId,
    sourceRepository: repository,
    branch,
    user,
    exportedAt: new Date().toISOString(),
    transcriptSource: input.transcriptPath,
  };
  await writeFile(
    path.join(sessionDir, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );

  // hooks.log accumulates across every session in the working copy, so export
  // only the lines belonging to this one. Unparsable lines are dropped.
  const log = await readFile(path.join(logDir, "hooks.log"), "utf8").catch(() => "");
  const lines = log.split("\n").filter((line) => {
    try {
      return JSON.parse(line).sessionId === input.sessionId;
    } catch {
      return false;
    }
  });

  if (lines.length) {
    await writeFile(path.join(sessionDir, "hooks.log"), `${lines.join("\n")}\n`);
  }
}

const test = spawnSync("pnpm", ["test"], { cwd: input.cwd, encoding: "utf8" });

// `test.error` covers "pnpm is not installed"; `status !== 0` covers real
// failures. Both must block, or the gate silently passes on a broken box.
if (test.error || test.status !== 0) {
  finish(
    "block",
    [
      "The completion gate failed.",
      "",
      "NOTE: Do not modify or delete the failing tests to make them pass, unless instructed by the user.",
      "Stop and present the issue to the user.",
      "",
      details(test.error?.message, test.stdout, test.stderr),
    ].join("\n"),
  );
}

try {
  await exportSession();
} catch (error) {
  // A failed export blocks too: silently losing history would defeat the gate.
  finish("block", `Tests passed, but the session export failed.\n\n${error.message}`);
}

finish("allow");
