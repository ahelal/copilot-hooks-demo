document.documentElement.dataset.viewerBuild = "4";

const state = {
  sessions: [],
  selectedId: null,
  tab: "overview",
  rawSource: "records",
  recordQuery: "",
  typeFilter: "",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatDate(value, options = {}) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function relativeDate(value) {
  if (!value) return "Unknown";
  const delta = Date.now() - new Date(value).getTime();
  const abs = Math.abs(delta);
  if (abs < 60_000) return "just now";
  if (abs < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (abs < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  if (abs < 604_800_000) return `${Math.round(delta / 86_400_000)}d ago`;
  return formatDate(value, { month: "short", day: "numeric" });
}

function duration(start, end) {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "Unknown duration";
  if (ms < 60_000) return `${Math.round(ms / 1000)} sec`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  const hours = Math.floor(ms / 3_600_000);
  return `${hours}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}

function recordType(record) {
  return record.type || record.event || record.kind || record.role || "unknown";
}

function recordTime(record) {
  return record.timestamp || record.recordedAt || null;
}

function recordText(record) {
  const data = record.data || record;
  let value;
  if (record.type === "user.message") value = data.content || data.transformedContent || "";
  else if (record.type === "assistant.message") value = data.content || data.reasoningText || "";
  else if (record.type === "system.message") value = data.content || "";
  if (record.type === "tool.execution_start") {
    value = `${data.toolName || "tool"} ${stringifyCompact(data.arguments)}`;
  }
  if (record.type === "tool.execution_complete") {
    value = data.error?.message || stringifyCompact(data.result) || `${data.toolCallId || "tool"} completed`;
  }
  if (record.event) {
    value = [record.toolName, record.source, record.reason, record.error].filter(Boolean).join(" ");
  }
  value ??= data.message || data.reason || data.hookType || data.kind || data;
  return stringifyCompact(value);
}

function stringifyCompact(value) {
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value)); } catch { return value; }
  }
  return value == null ? "" : JSON.stringify(value);
}

function selected() {
  return state.sessions.find((session) => session.id === state.selectedId);
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 1800);
}

async function loadData({ preserve = true } = {}) {
  $("#refresh").disabled = true;
  try {
    let data;
    try {
      const response = await fetch("/api/sessions");
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      data = await response.json();
    } catch (error) {
      if (!window.__SESSION_DATA__) throw error;
      data = window.__SESSION_DATA__;
    }
    state.sessions = data.sessions;
    if (!preserve || !state.sessions.some((session) => session.id === state.selectedId)) {
      state.selectedId = state.sessions[0]?.id || null;
    }
    $("#log-root").textContent = data.logRoot;
    $("#last-loaded").textContent = `Updated ${formatDate(data.generatedAt, { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
    renderSessionList();
    renderSelected();
    if (data.errors.length) toast(`${data.errors.length} session read error(s)`);
  } catch (error) {
    $("#empty-state").innerHTML = "";
    $("#empty-state").append(
      el("h1", "", "Could not read session data"),
      el("p", "", `${error.message}. Run “pnpm viewer”, then reload this page.`),
    );
  } finally {
    $("#refresh").disabled = false;
  }
}

function searchableSession(session) {
  return JSON.stringify(session).toLowerCase();
}

function renderSessionList() {
  const query = $("#session-search").value.trim().toLowerCase();
  const sort = $("#session-sort").value;
  const sessions = state.sessions
    .filter((session) => !query || searchableSession(session).includes(query))
    .sort((a, b) => {
      if (sort === "oldest") return String(a.summary.startedAt).localeCompare(String(b.summary.startedAt));
      if (sort === "largest") return (b.summary.recordCount + b.summary.hookCount) - (a.summary.recordCount + a.summary.hookCount);
      return String(b.summary.endedAt).localeCompare(String(a.summary.endedAt));
    });

  $("#session-count").textContent = `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
  const list = $("#session-list");
  list.replaceChildren();

  for (const session of sessions) {
    const button = el("button", `session-item${session.id === state.selectedId ? " active" : ""}`);
    button.type = "button";
    button.dataset.sessionId = session.id;
    const top = el("div", "session-item-top");
    top.append(el("strong", "", session.summary.title), el("time", "", relativeDate(session.summary.endedAt)));
    const stats = el("div", "session-stats");
    stats.append(
      el("span", "", `${session.summary.messageCount} messages`),
      el("span", "", `${session.summary.toolCount} tools`),
    );
    if (session.summary.failedToolCount) {
      const failed = el("span");
      failed.append(el("i", "dot-danger"), `${session.summary.failedToolCount} failed`);
      stats.append(failed);
    }
    button.append(top, el("p", "", session.summary.preview || session.id), stats);
    list.append(button);
  }

  if (!sessions.length) list.append(el("div", "empty-inline", "No sessions match your search."));
}

function renderSelected() {
  const session = selected();
  $("#empty-state").hidden = Boolean(session);
  $("#session-view").hidden = !session;
  if (!session) {
    if (!state.sessions.length) {
      $("#empty-state").replaceChildren(
        el("h1", "", "No exported sessions yet"),
        el("p", "", "The viewer is ready. Complete a Copilot turn to export session data."),
      );
    }
    return;
  }

  const producer = session.records.find((record) => record.type === "session.start")?.data?.producer;
  $("#source-badge").textContent = producer || (session.metadata.transcriptSource?.includes("Code/") ? "VS CODE" : "COPILOT CLI");
  $("#session-time").textContent = formatDate(session.summary.startedAt, { dateStyle: "medium", timeStyle: "short" });
  $("#session-title").textContent = session.summary.title;
  $("#session-preview").textContent = session.summary.preview;
  const meta = $("#hero-meta");
  meta.replaceChildren();
  for (const [label, value] of [
    ["Repository", session.metadata.sourceRepository],
    ["Branch", session.metadata.branch],
    ["User", session.metadata.user],
    ["ID", session.id],
  ]) {
    const item = el("span");
    item.append(el("b", "", `${label}: `), document.createTextNode(value || "—"));
    meta.append(item);
  }

  renderOverview(session);
  renderConversation(session);
  populateTypeFilter(session);
  renderTimeline(session);
  renderRaw(session);
}

function renderOverview(session) {
  const summary = session.summary;
  const metrics = [
    ["Messages", summary.messageCount, `${session.records.filter((r) => r.type === "user.message").length} user prompts`],
    ["Tool calls", summary.toolCount, summary.failedToolCount ? `${summary.failedToolCount} failed` : "All completed cleanly"],
    ["Hook events", summary.hookCount, `${Object.keys(summary.types).filter((type) => type.toLowerCase().includes("hook")).length} hook record types`],
    ["Record types", Object.keys(summary.types).length, `${summary.recordCount + summary.hookCount} total records`],
  ];
  const grid = $("#metric-grid");
  grid.replaceChildren();
  for (const [label, value, note] of metrics) {
    const metric = el("div", "metric");
    metric.append(el("span", "metric-label", label), el("span", "metric-value", value), el("span", "metric-note", note));
    grid.append(metric);
  }

  $("#duration-label").textContent = duration(summary.startedAt, summary.endedAt);
  renderActivity(session);
  renderRanks("#tool-chart", summary.tools, "No tool calls recorded");
  renderRanks("#type-chart", summary.types, "No records found", 7);

  const parseErrorCount = session.parseErrors.transcript.length + session.parseErrors.hooks.length;
  const diagnostics = [
    [summary.failedToolCount ? "status-bad" : "status-good", "Tool execution", summary.failedToolCount ? `${summary.failedToolCount} failure(s) detected` : "No failed tools detected"],
    [parseErrorCount ? "status-bad" : "status-good", "Data integrity", parseErrorCount ? `${parseErrorCount} malformed JSON line(s)` : "All JSON lines parsed"],
    [session.hooks.length ? "status-good" : "status-warn", "Hook coverage", session.hooks.length ? `${session.hooks.length} lifecycle events captured` : "No per-session hook log"],
    [summary.endedAt ? "status-good" : "status-warn", "Timeline", summary.endedAt ? duration(summary.startedAt, summary.endedAt) : "Incomplete timestamps"],
    ["", "Export", formatDate(session.metadata.exportedAt, { dateStyle: "medium", timeStyle: "short" })],
    ["", "Location", session.files.directory],
  ];
  const container = $("#diagnostics");
  container.replaceChildren();
  for (const [status, title, detail] of diagnostics) {
    const item = el("div", "diagnostic");
    item.append(el("strong", status, title), el("span", "", detail));
    container.append(item);
  }
}

function renderActivity(session) {
  const records = [...session.records, ...session.hooks].filter((record) => recordTime(record));
  const start = new Date(session.summary.startedAt).getTime();
  const end = new Date(session.summary.endedAt).getTime();
  const buckets = Array(36).fill(0);
  const span = Math.max(1, end - start);
  for (const record of records) {
    const index = Math.min(buckets.length - 1, Math.floor(((new Date(recordTime(record)).getTime() - start) / span) * buckets.length));
    if (index >= 0) buckets[index]++;
  }
  const max = Math.max(...buckets, 1);
  const chart = $("#activity-chart");
  chart.replaceChildren();
  buckets.forEach((count, index) => {
    const bar = el("div", `activity-bar${count / max > .72 ? " hot" : ""}`);
    bar.style.height = `${Math.max(2, count / max * 100)}%`;
    bar.dataset.label = `${count} event${count === 1 ? "" : "s"} · ${Math.round(index / buckets.length * 100)}%`;
    chart.append(bar);
  });
}

function renderRanks(selector, values, emptyText, limit = 8) {
  const container = $(selector);
  container.replaceChildren();
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (!entries.length) return container.append(el("div", "empty-inline", emptyText));
  const max = entries[0][1];
  for (const [name, count] of entries) {
    const row = el("div", "rank-row");
    const track = el("div", "rank-track");
    const fill = el("div", "rank-fill");
    fill.style.width = `${count / max * 100}%`;
    track.append(fill);
    row.append(el("span", "rank-name", name), track, el("span", "rank-count", count));
    container.append(row);
  }
}

function renderConversation(session) {
  const records = session.records.filter((record) =>
    ["user.message", "assistant.message", "system.message"].includes(record.type));
  $("#conversation-count").textContent = `${records.length} messages`;
  const container = $("#conversation");
  container.replaceChildren();

  for (const record of records) {
    const role = record.type.split(".")[0];
    const data = record.data || {};
    if (!data.content && !data.reasoningText && !data.toolRequests?.length) continue;
    const message = el("article", `message ${role}`);
    const avatar = el("div", "avatar", role === "assistant" ? "CO" : role === "user" ? "YOU" : "SYS");
    const body = el("div", "message-body");
    const head = el("div", "message-head");
    head.append(el("strong", "", role === "assistant" ? "Copilot" : role[0].toUpperCase() + role.slice(1)));
    head.append(el("time", "", formatDate(record.timestamp, { hour: "numeric", minute: "2-digit", second: "2-digit" })));
    body.append(head);
    if (data.content) body.append(el("div", "message-content", typeof data.content === "string" ? data.content : stringifyCompact(data.content)));
    if (data.reasoningText && $("#show-reasoning").checked) body.append(el("div", "reasoning", data.reasoningText));
    for (const request of data.toolRequests || []) {
      const details = el("details", "tool-request");
      details.append(el("summary", "", request.name || request.toolName || "Tool request"));
      const pre = el("pre", "", JSON.stringify(request.arguments ?? request, null, 2));
      details.append(pre);
      body.append(details);
    }
    message.append(avatar, body);
    container.append(message);
  }
  if (!container.children.length) container.append(el("div", "empty-inline", "No conversation messages in this transcript."));
}

function allTimelineRecords(session) {
  return [
    ...session.records.map((record) => ({ ...record, _source: "transcript" })),
    ...session.hooks.map((record) => ({ ...record, _source: "hooks" })),
  ].sort((a, b) => String(recordTime(a)).localeCompare(String(recordTime(b))));
}

function populateTypeFilter(session) {
  const types = [...new Set(allTimelineRecords(session).map(recordType))].sort();
  const select = $("#type-filter");
  select.replaceChildren(new Option("All types", ""));
  for (const type of types) select.append(new Option(type, type));
  state.typeFilter = "";
}

function renderTimeline(session) {
  const query = state.recordQuery.toLowerCase();
  const records = allTimelineRecords(session).filter((record) =>
    (!state.typeFilter || recordType(record) === state.typeFilter)
    && (!query || JSON.stringify(record).toLowerCase().includes(query)));
  $("#timeline-count").textContent = `${records.length} records`;
  const container = $("#timeline");
  container.replaceChildren();
  for (const record of records) {
    const item = el("article", "timeline-item");
    const top = el("div", "timeline-top");
    top.append(el("span", "type-chip", recordType(record)), el("span", "subtle", record._source));
    top.append(el("time", "", formatDate(recordTime(record), { hour: "numeric", minute: "2-digit", second: "2-digit" })));
    item.append(top);
    const summary = recordText(record);
    if (summary != null) {
      item.append(el("div", "timeline-summary", String(summary).slice(0, 1200)));
    }
    item.title = record.id || record.sessionId || "";
    container.append(item);
  }
  if (!records.length) container.append(el("div", "empty-inline", "No records match these filters."));
}

function renderRaw(session) {
  const source = state.rawSource;
  const records = source === "metadata" ? [session.metadata] : session[source];
  const container = $("#raw-records");
  container.replaceChildren();
  records.forEach((record, index) => {
    const details = el("details", "raw-record");
    const summary = el("summary");
    summary.append(el("span", "raw-index", String(index + 1).padStart(3, "0")), el("span", "type-chip", source === "metadata" ? "metadata" : recordType(record)));
    if (recordTime(record)) summary.append(el("time", "", formatDate(recordTime(record), { hour: "numeric", minute: "2-digit", second: "2-digit" })));
    details.append(summary, el("pre", "", JSON.stringify(record, null, 2)));
    container.append(details);
  });
  if (!records.length) container.append(el("div", "empty-inline", `No ${source} records for this session.`));
}

function switchTab(tab) {
  state.tab = tab;
  $$(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${tab}`));
}

$("#session-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-session-id]");
  if (!button) return;
  state.selectedId = button.dataset.sessionId;
  renderSessionList();
  renderSelected();
  document.querySelector(".workspace").scrollTo?.({ top: 0 });
});
$("#session-search").addEventListener("input", renderSessionList);
$("#session-sort").addEventListener("change", renderSessionList);
$("#record-search").addEventListener("input", (event) => {
  state.recordQuery = event.target.value;
  renderTimeline(selected());
});
$("#type-filter").addEventListener("change", (event) => {
  state.typeFilter = event.target.value;
  renderTimeline(selected());
});
$("#show-reasoning").addEventListener("change", () => renderConversation(selected()));
$(".tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-tab]");
  if (button) switchTab(button.dataset.tab);
});
$(".segmented").addEventListener("click", (event) => {
  const button = event.target.closest("[data-raw-source]");
  if (!button) return;
  state.rawSource = button.dataset.rawSource;
  $$(".segmented button").forEach((item) => item.classList.toggle("active", item === button));
  renderRaw(selected());
});
$("#refresh").addEventListener("click", async () => {
  await loadData();
  toast("Session data refreshed");
});
$("#theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    $("#session-search").focus();
  }
});

loadData({ preserve: false });
