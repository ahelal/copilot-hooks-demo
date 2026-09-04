import { createServer } from "node:http";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webDir, "..");
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const port = Number(option("--port", process.env.PORT || "4173"));
const logRoot = path.resolve(repoRoot, option("--logs", ".copilot-hooks-session-logs"));
const sessionRoot = path.join(logRoot, "sessions");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

async function findFiles(root, name) {
  const matches = [];
  let entries;

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return matches;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) matches.push(...await findFiles(entryPath, name));
    if (entry.isFile() && entry.name === name) matches.push(entryPath);
  }

  return matches;
}

async function readJson(file, fallback = {}) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    return { ...fallback, _error: error.message };
  }
}

async function readJsonLines(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { records: [], errors: [] };
    throw error;
  }

  const records = [];
  const errors = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      errors.push({ line: index + 1, message: error.message, raw: line });
    }
  });
  return { records, errors };
}

function text(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

function recordType(record) {
  return record.type || record.event || record.kind || record.role || "unknown";
}

function buildSummary(metadata, transcript, hooks, directory) {
  const records = transcript.records;
  const firstUser = records.find((record) => record.type === "user.message");
  const sessionInfo = records.find(
    (record) => record.type === "session.info" && record.data?.infoType === "session.title",
  );
  const timestamps = [...records, ...hooks.records]
    .map((record) => record.timestamp || record.recordedAt)
    .filter(Boolean)
    .sort();
  const toolStarts = records.filter((record) => record.type === "tool.execution_start");
  const toolCompletes = records.filter((record) => record.type === "tool.execution_complete");
  const failedTools = toolCompletes.filter((record) => record.data?.success === false);
  const types = {};
  const tools = {};

  for (const record of [...records, ...hooks.records]) {
    const type = recordType(record);
    types[type] = (types[type] || 0) + 1;
  }
  for (const record of toolStarts) {
    const name = record.data?.toolName || "unknown";
    tools[name] = (tools[name] || 0) + 1;
  }

  const prompt = text(firstUser?.data?.content).trim();
  const title = text(sessionInfo?.data?.message).trim()
    || prompt.split(/\r?\n/)[0].slice(0, 72)
    || `Session ${metadata.sessionId?.slice(0, 8) || path.basename(directory).slice(0, 8)}`;

  return {
    title,
    preview: prompt.slice(0, 180),
    startedAt: timestamps[0] || metadata.exportedAt || null,
    endedAt: timestamps.at(-1) || metadata.exportedAt || null,
    recordCount: records.length,
    hookCount: hooks.records.length,
    messageCount: records.filter((record) =>
      ["user.message", "assistant.message", "system.message"].includes(record.type)).length,
    toolCount: toolStarts.length,
    failedToolCount: failedTools.length,
    types,
    tools,
  };
}

async function loadSession(metadataFile) {
  const directory = path.dirname(metadataFile);
  const [metadata, transcript, hooks, directoryStats] = await Promise.all([
    readJson(metadataFile),
    readJsonLines(path.join(directory, "transcript.jsonl")),
    readJsonLines(path.join(directory, "hooks.log")),
    stat(directory),
  ]);
  const id = metadata.sessionId || path.basename(directory);

  return {
    id,
    metadata,
    summary: buildSummary(metadata, transcript, hooks, directory),
    records: transcript.records,
    hooks: hooks.records,
    parseErrors: {
      transcript: transcript.errors,
      hooks: hooks.errors,
    },
    files: {
      directory: path.relative(repoRoot, directory),
      transcript: "transcript.jsonl",
      metadata: "metadata.json",
      hooks: hooks.records.length ? "hooks.log" : null,
      modifiedAt: directoryStats.mtime.toISOString(),
    },
  };
}

async function loadSessions() {
  const metadataFiles = await findFiles(sessionRoot, "metadata.json");
  const results = await Promise.allSettled(metadataFiles.map(loadSession));
  const sessions = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .sort((a, b) => String(b.summary.endedAt).localeCompare(String(a.summary.endedAt)));
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason.message);

  return {
    generatedAt: new Date().toISOString(),
    logRoot: path.relative(repoRoot, logRoot) || ".",
    sessions,
    errors,
  };
}

function send(response, status, body, type = "application/json; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

const snapshot = await loadSessions();
await writeFile(
  path.join(webDir, "session-data.js"),
  `window.__SESSION_DATA__ = ${JSON.stringify(snapshot)};\n`,
  "utf8",
);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/api/sessions") {
      return send(response, 200, JSON.stringify(await loadSessions()));
    }

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.resolve(webDir, `.${pathname}`);
    if (!file.startsWith(`${webDir}${path.sep}`)) {
      return send(response, 403, JSON.stringify({ error: "Forbidden" }));
    }

    const extension = path.extname(file);
    if (!contentTypes[extension]) {
      return send(response, 404, JSON.stringify({ error: "Not found" }));
    }
    send(response, 200, await readFile(file), contentTypes[extension]);
  } catch (error) {
    const status = error.code === "ENOENT" ? 404 : 500;
    send(response, status, JSON.stringify({ error: status === 404 ? "Not found" : error.message }));
  }
});

server.on("error", (error) => {
  if (error.code === "EPERM" || error.code === "EACCES") {
    console.log("");
    console.log("Local ports are blocked in this terminal environment.");
    console.log(`A static snapshot was generated at: ${path.join(webDir, "index.html")}`);
    console.log("Open web/index.html directly in your browser.");
    process.exitCode = 0;
    return;
  }

  throw error;
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Copilot Session Observatory: http://127.0.0.1:${port}`);
  console.log(`Reading: ${logRoot}`);
});
