/**
 * Observability hook: appends one JSON line per lifecycle event to hooks.log.
 * Records metadata only — never prompt text or tool payloads. The full
 * conversation is exported separately by stop-gate.mjs once the tests pass.
 *
 * Usage: node log-event.mjs <eventName>
 *
 * Each event runs in its own short-lived process, so entries written
 * milliseconds apart can land out of order. Sort on `recordedAt`, not file order.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { readHookInput, resolveLogDir } from "./hook-utils.mjs";

const input = await readHookInput();
const logDir = resolveLogDir(input.cwd);

const entry = {
  recordedAt: new Date().toISOString(),
  // The event name is passed as an argument so one script can serve every
  // event; the payload field is only a fallback.
  event: process.argv[2] || input.event || "unknown",
  sessionId: input.sessionId,
  cwd: input.cwd,
  // Event-specific fields are omitted rather than written as null, which keeps
  // `grep` on a field meaningful.
  ...(input.toolName && { toolName: input.toolName }),
  ...(input.source && { source: input.source }),
  ...(input.reason && { reason: input.reason }),
  ...(input.error && { error: input.error }),
};

await mkdir(logDir, { recursive: true });
await appendFile(path.join(logDir, "hooks.log"), `${JSON.stringify(entry)}\n`, "utf8");

// `{}` is the no-op response: observe, then let the turn proceed unchanged.
process.stdout.write("{}");
