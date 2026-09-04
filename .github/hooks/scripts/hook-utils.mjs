/**
 * Shared plumbing for the hook scripts in this repository.
 *
 * A hook is a plain process: Copilot writes one JSON payload to stdin and reads
 * one JSON object back from stdout.
 *
 * Copilot CLI and VS Code spell the same fields differently (`toolName` vs
 * `tool_name`), so the payload is normalised once here and callers never have to
 * know about both.
 */
import path from "node:path";

function parseToolArgs(raw) {
  if (typeof raw !== "string") {
    return raw ?? {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    // Fail open: an unreadable payload must not crash the turn.
    return {};
  }
}

export async function readHookInput() {
  let raw = "";

  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  // Some lifecycle events are sent with no body at all.
  const input = raw.trim() ? JSON.parse(raw) : {};

  return {
    event: input.hook_event_name ?? "",
    sessionId: input.sessionId ?? input.session_id ?? "unknown-session",
    toolName: input.toolName ?? input.tool_name ?? "",
    toolArgs: parseToolArgs(input.toolArgs ?? input.toolInput ?? input.tool_input),
    transcriptPath: input.transcriptPath ?? input.transcript_path ?? "",
    cwd: input.cwd ?? process.cwd(),
    source: input.source ?? "",
    reason: input.reason ?? "",
    error: input.error?.message ?? "",
  };
}

export function resolveLogDir(cwd) {
  return path.resolve(cwd, process.env.HOOKS_LOG_DIR ?? ".copilot-hooks-session-logs");
}
