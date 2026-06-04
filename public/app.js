const MESSAGE_PAGE_SIZE = 80;
const LONG_THREAD_MESSAGE_HINT = 120;
const LONG_THREAD_BYTES = 8 * 1024 * 1024;

const state = {
  index: null,
  selectedProjectId: "all",
  selectedProvider: "all",
  selectedSessionId: "",
  sessionLimit: 120,
  filter: "",
  readerSession: null,
  readerMessages: [],
  readerHasMore: false,
  readerLoading: false,
  readerRequestId: 0,
  exportMenuOpen: false,
  exportLoading: false
};

const els = {
  refreshButton: document.getElementById("refreshButton"),
  deepSearchButton: document.getElementById("deepSearchButton"),
  filterInput: document.getElementById("filterInput"),
  providerFilters: document.getElementById("providerFilters"),
  projectList: document.getElementById("projectList"),
  sessionList: document.getElementById("sessionList"),
  projectCount: document.getElementById("projectCount"),
  sessionCount: document.getElementById("sessionCount"),
  activeProjectName: document.getElementById("activeProjectName"),
  activeProjectPath: document.getElementById("activeProjectPath"),
  metricProjects: document.getElementById("metricProjects"),
  metricSessions: document.getElementById("metricSessions"),
  metricMessages: document.getElementById("metricMessages"),
  metricSensitive: document.getElementById("metricSensitive"),
  readerEmpty: document.getElementById("readerEmpty"),
  readerContent: document.getElementById("readerContent"),
  readerProvider: document.getElementById("readerProvider"),
  readerTitle: document.getElementById("readerTitle"),
  readerSubtitle: document.getElementById("readerSubtitle"),
  readerMessages: document.getElementById("readerMessages"),
  readerThreadId: document.getElementById("readerThreadId"),
  readerUpdated: document.getElementById("readerUpdated"),
  readerModel: document.getElementById("readerModel"),
  readerFlags: document.getElementById("readerFlags"),
  privacyPanel: document.getElementById("privacyPanel"),
  transcriptNotice: document.getElementById("transcriptNotice"),
  transcriptNoticeTitle: document.getElementById("transcriptNoticeTitle"),
  transcriptNoticeText: document.getElementById("transcriptNoticeText"),
  loadMoreMessagesButton: document.getElementById("loadMoreMessagesButton"),
  messageList: document.getElementById("messageList"),
  exportButton: document.getElementById("exportButton"),
  exportMenu: document.getElementById("exportMenu"),
  exportMarkdownButton: document.getElementById("exportMarkdownButton"),
  exportJsonButton: document.getElementById("exportJsonButton"),
  copyResumeButton: document.getElementById("copyResumeButton"),
  copyPathButton: document.getElementById("copyPathButton"),
  toast: document.getElementById("toast")
};

const providerNames = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
  grok: "Grok Build",
  antigravity: "Antigravity"
};

function formatNumber(value) {
  return new Intl.NumberFormat().format(value || 0);
}

function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function matchesFilter(session, filter) {
  if (!filter) return true;
  const haystack = [
    session.title,
    session.subtitle,
    session.providerLabel,
    session.provider,
    session.projectName,
    session.projectPath,
    session.firstUserText,
    session.lastMessageText,
    session.model
  ].map(lower).join(" ");
  return haystack.includes(filter);
}

function providerBadge(provider) {
  const span = document.createElement("span");
  span.className = `provider-badge ${provider}`;
  span.textContent = providerNames[provider] || provider;
  return span;
}

function messageCountLabel(item) {
  return `${formatNumber(item.messageCount)}${item.indexSampled ? "+" : ""} msg`;
}

function isLargeSession(session) {
  if (!session) return false;
  return Boolean(session.indexSampled) || session.messageCount >= LONG_THREAD_MESSAGE_HINT || session.fileSize >= LONG_THREAD_BYTES;
}

function sessionLoadNote(session) {
  if (!isLargeSession(session)) return "";
  const size = session.fileSize ? `${formatNumber(Math.round(session.fileSize / 1024 / 1024))} MB source` : "large source";
  return `${size}. Loaded in ${MESSAGE_PAGE_SIZE}-message chunks.`;
}

function sessionThreadId(session) {
  return session?.nativeSessionId || session?.id || "";
}

function tinyBadge(text, extraClass = "") {
  const span = document.createElement("span");
  span.className = `tiny-badge ${extraClass}`.trim();
  span.textContent = text;
  return span;
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function fetchJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

async function loadIndex(refresh = false) {
  showToast(refresh ? "Refreshing local history..." : "Scanning local history...");
  const index = await fetchJson(`/api/index${refresh ? "?refresh=1" : ""}`);
  state.index = index;
  render();
  if (state.selectedSessionId && index.sessions.some((session) => session.id === state.selectedSessionId)) {
    loadSession(state.selectedSessionId);
  } else {
    state.selectedSessionId = "";
    state.readerSession = null;
    state.readerMessages = [];
    state.readerHasMore = false;
    state.readerLoading = false;
    state.exportLoading = false;
    setExportMenu(false);
    els.readerEmpty.classList.remove("hidden");
    els.readerContent.classList.add("hidden");
  }
  showToast(`Indexed ${formatNumber(index.stats.sessions)} sessions in ${index.scanMs} ms`);
}

async function loadSession(sessionId, { append = false } = {}) {
  const summary = state.index?.sessions.find((session) => session.id === sessionId);
  const offset = append ? state.readerMessages.length : 0;
  const requestId = state.readerRequestId + 1;
  state.readerRequestId = requestId;
  state.selectedSessionId = sessionId;
  state.readerLoading = true;
  if (!append) {
    state.readerSession = null;
    state.readerMessages = [];
    state.readerHasMore = false;
  }
  setExportMenu(false);
  renderSessions();
  els.readerEmpty.classList.add("hidden");
  els.readerContent.classList.remove("hidden");
  renderReaderLoading(summary, append);
  await nextPaint();

  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(MESSAGE_PAGE_SIZE)
  });
  try {
    const details = await fetchJson(`/api/session/${encodeURIComponent(sessionId)}?${params.toString()}`);
    if (requestId !== state.readerRequestId) return;
    state.readerSession = details.session;
    state.readerMessages = append ? state.readerMessages.concat(details.messages || []) : details.messages || [];
    state.readerHasMore = Boolean(details.page?.hasMore || details.session?.hasMore);
    state.readerLoading = false;
    renderReader();
  } catch (error) {
    if (requestId === state.readerRequestId) {
      state.readerLoading = false;
      renderReaderError(summary, error);
    }
    throw error;
  }
}

function renderReaderLoading(summary, append) {
  const session = summary || state.readerSession;
  els.readerProvider.textContent = session ? `${session.providerLabel} / ${session.projectName}` : "Loading";
  els.readerTitle.textContent = session?.title || "Loading transcript";
  els.readerSubtitle.textContent = session?.projectPath || session?.sourcePath || "";
  els.readerMessages.textContent = append ? `${formatNumber(state.readerMessages.length)} loaded` : "...";
  els.readerThreadId.textContent = sessionThreadId(session) || "-";
  els.readerThreadId.title = sessionThreadId(session);
  els.readerUpdated.textContent = session ? formatDate(session.updatedAt) : "-";
  els.readerModel.textContent = session?.model || "-";
  els.readerFlags.textContent = session ? formatNumber(session.sensitiveCount) : "-";
  els.privacyPanel.classList.add("hidden");
  updateExportControls();
  updateTranscriptNotice(session, append ? "append-loading" : "loading");

  if (!append) {
    els.messageList.innerHTML = `
      <div class="reader-skeleton">
        <div></div>
        <div></div>
        <div></div>
      </div>
    `;
  }
}

function renderReaderError(summary, error) {
  const session = summary || state.readerSession;
  els.readerProvider.textContent = session ? `${session.providerLabel} / ${session.projectName}` : "Transcript";
  els.readerTitle.textContent = session?.title || "Transcript did not load";
  els.readerSubtitle.textContent = session?.sourcePath || "";
  els.readerThreadId.textContent = sessionThreadId(session) || "-";
  els.readerThreadId.title = sessionThreadId(session);
  els.transcriptNotice.classList.remove("hidden");
  els.transcriptNoticeTitle.textContent = "Transcript load failed";
  els.transcriptNoticeText.textContent = error.message || "The local transcript could not be read.";
  els.loadMoreMessagesButton.classList.add("hidden");
  updateExportControls();
  els.messageList.innerHTML = `<div class="empty-state">Try refreshing the index, then open the session again.</div>`;
}

function visibleSessions() {
  if (!state.index) return [];
  const filter = lower(state.filter.trim());
  return state.index.sessions.filter((session) => {
    if (state.selectedProvider !== "all" && session.provider !== state.selectedProvider) return false;
    if (state.selectedProjectId !== "all") {
      const project = state.index.projects.find((item) => item.id === state.selectedProjectId);
      if (!project || session.projectPath !== project.path) return false;
    }
    return matchesFilter(session, filter);
  });
}

function visibleProjects() {
  if (!state.index) return [];
  const filter = lower(state.filter.trim());
  return state.index.projects.filter((project) => {
    if (state.selectedProvider !== "all" && !project.providers.includes(state.selectedProvider)) return false;
    if (!filter) return true;
    return lower(`${project.name} ${project.path} ${project.providers.join(" ")}`).includes(filter) ||
      state.index.sessions.some((session) => session.projectPath === project.path && matchesFilter(session, filter));
  });
}

function render() {
  renderMetrics();
  renderProviders();
  renderProjects();
  renderSessions();
}

function renderMetrics() {
  const stats = state.index?.stats || {};
  els.metricProjects.textContent = formatNumber(stats.projects);
  els.metricSessions.textContent = formatNumber(stats.sessions);
  els.metricMessages.textContent = formatNumber(stats.messages);
  els.metricSensitive.textContent = formatNumber(stats.sensitive);
}

function renderProviders() {
  const providers = state.index?.providers || [];
  els.providerFilters.replaceChildren();

  const all = document.createElement("button");
  all.className = `provider-chip ${state.selectedProvider === "all" ? "active" : ""}`;
  all.type = "button";
  all.textContent = "All";
  all.addEventListener("click", () => {
    state.selectedProvider = "all";
    state.sessionLimit = 120;
    render();
  });
  els.providerFilters.appendChild(all);

  for (const provider of providers) {
    const button = document.createElement("button");
    button.className = `provider-chip ${state.selectedProvider === provider.id ? "active" : ""}`;
    button.type = "button";
    button.textContent = `${provider.label} ${provider.sessionCount}`;
    button.addEventListener("click", () => {
      state.selectedProvider = provider.id;
      state.sessionLimit = 120;
      render();
    });
    els.providerFilters.appendChild(button);
  }
}

function renderProjects() {
  const projects = visibleProjects();
  els.projectCount.textContent = formatNumber(projects.length);
  els.projectList.replaceChildren();

  const all = document.createElement("button");
  all.className = `project-item ${state.selectedProjectId === "all" ? "active" : ""}`;
  all.type = "button";
  all.addEventListener("click", () => {
    state.selectedProjectId = "all";
    state.sessionLimit = 120;
    render();
  });
  all.innerHTML = `
    <div class="project-title"><strong>All projects</strong><span>${formatNumber(state.index?.stats?.sessions || 0)}</span></div>
    <p class="project-path">Unified history across detected local tools</p>
  `;
  els.projectList.appendChild(all);

  if (!projects.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No projects match the current filter.";
    els.projectList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const project of projects) {
    const button = document.createElement("button");
    button.className = `project-item ${state.selectedProjectId === project.id ? "active" : ""}`;
    button.type = "button";
    button.addEventListener("click", () => {
      state.selectedProjectId = project.id;
      state.sessionLimit = 120;
      state.selectedSessionId = "";
      state.readerSession = null;
      state.readerMessages = [];
      state.readerHasMore = false;
      state.exportLoading = false;
      setExportMenu(false);
      els.readerEmpty.classList.remove("hidden");
      els.readerContent.classList.add("hidden");
      render();
    });

    const title = document.createElement("div");
    title.className = "project-title";
    const name = document.createElement("strong");
    name.textContent = project.name;
    const count = document.createElement("span");
    count.textContent = formatNumber(project.sessionCount);
    title.append(name, count);

    const path = document.createElement("p");
    path.className = "project-path";
    path.textContent = project.path;

    const meta = document.createElement("div");
    meta.className = "meta-row";
    project.providers.forEach((provider) => meta.appendChild(providerBadge(provider)));
    meta.appendChild(tinyBadge(messageCountLabel(project)));
    if (project.sensitiveCount) meta.appendChild(tinyBadge(`${project.sensitiveCount} flags`, "flag"));

    button.append(title, path, meta);
    fragment.appendChild(button);
  }
  els.projectList.appendChild(fragment);
}

function renderSessions() {
  const sessions = visibleSessions();
  const activeProject = state.index?.projects?.find((project) => project.id === state.selectedProjectId);
  els.sessionCount.textContent = formatNumber(sessions.length);
  els.activeProjectName.textContent = activeProject ? activeProject.name : "Recent sessions";
  els.activeProjectPath.textContent = activeProject ? activeProject.path : "All projects";
  els.sessionList.replaceChildren();

  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No sessions match the current filter.";
    els.sessionList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const session of sessions.slice(0, state.sessionLimit)) {
    const button = document.createElement("button");
    button.className = `session-item ${state.selectedSessionId === session.id ? "active" : ""}`;
    button.type = "button";
    button.addEventListener("click", () => loadSession(session.id));

    const title = document.createElement("div");
    title.className = "session-title";
    const strong = document.createElement("strong");
    strong.textContent = session.title || "Untitled session";
    const time = document.createElement("span");
    time.textContent = formatTime(session.updatedAt);
    title.append(strong, time);

    const preview = document.createElement("p");
    preview.className = "session-preview";
    preview.textContent = session.firstUserText || session.subtitle || session.lastMessageText || session.sourcePath;

    const meta = document.createElement("div");
    meta.className = "meta-row";
    meta.appendChild(providerBadge(session.provider));
    meta.appendChild(tinyBadge(messageCountLabel(session)));
    if (isLargeSession(session)) meta.appendChild(tinyBadge("chunked load", "info"));
    if (session.archived) meta.appendChild(tinyBadge("archived"));
    if (session.sensitiveCount) meta.appendChild(tinyBadge(`${session.sensitiveCount} flags`, "flag"));

    button.append(title, preview, meta);
    fragment.appendChild(button);
  }
  els.sessionList.appendChild(fragment);

  if (sessions.length > state.sessionLimit) {
    const more = document.createElement("button");
    more.className = "session-item load-more";
    more.type = "button";
    more.textContent = `Show next ${Math.min(120, sessions.length - state.sessionLimit)} sessions`;
    more.addEventListener("click", () => {
      state.sessionLimit += 120;
      renderSessions();
    });
    els.sessionList.appendChild(more);
  }
}

function renderReader() {
  const session = state.readerSession;
  if (!session) return;

  els.readerProvider.textContent = `${session.providerLabel} / ${session.projectName}`;
  els.readerTitle.textContent = session.title || "Untitled session";
  els.readerSubtitle.textContent = session.projectPath || session.sourcePath || "";
  els.readerMessages.textContent = session.totalKnown
    ? `${formatNumber(state.readerMessages.length)} / ${formatNumber(session.messageCount)}`
    : `${formatNumber(state.readerMessages.length)} loaded`;
  els.readerThreadId.textContent = sessionThreadId(session) || "-";
  els.readerThreadId.title = sessionThreadId(session);
  els.readerUpdated.textContent = formatDate(session.updatedAt);
  els.readerModel.textContent = session.model || "-";
  els.readerFlags.textContent = formatNumber(session.sensitiveCount);
  updateExportControls();

  if (session.sensitiveCount) {
    const kinds = Object.entries(session.sensitiveKinds || {})
      .map(([label, count]) => `${label}: ${count}`)
      .join(" / ");
    els.privacyPanel.textContent = `Privacy radar found ${session.sensitiveCount} possible sensitive item(s): ${kinds}. Detection is local and approximate.`;
    els.privacyPanel.classList.remove("hidden");
  } else {
    els.privacyPanel.classList.add("hidden");
  }

  updateTranscriptNotice(session, state.readerHasMore ? "partial" : "complete");

  const fragment = document.createDocumentFragment();
  for (const message of state.readerMessages) {
    const item = document.createElement("section");
    item.className = "message";

    const role = document.createElement("div");
    role.className = `message-role ${message.role}`;
    role.textContent = message.role || "system";

    const body = document.createElement("div");
    body.className = "message-body";
    const time = document.createElement("div");
    time.className = "message-time";
    time.textContent = `${formatDate(message.timestamp)} / line ${message.lineNumber}`;
    const text = document.createElement("p");
    text.className = "message-text";
    text.textContent = message.text || message.title || "[empty]";
    body.append(time, text);

    if (message.sensitive?.length) {
      const flags = document.createElement("div");
      flags.className = "message-flags meta-row";
      message.sensitive.forEach((finding) => flags.appendChild(tinyBadge(`${finding.label} ${finding.count}`, "flag")));
      body.appendChild(flags);
    }

    item.append(role, body);
    fragment.appendChild(item);
  }

  const footer = document.createElement("div");
  footer.className = "message-footer";
  if (state.readerHasMore) {
    const note = document.createElement("p");
    note.textContent = `Showing ${formatNumber(state.readerMessages.length)} messages. Load the next chunk when you need more of this transcript.`;
    const button = document.createElement("button");
    button.className = "button primary compact";
    button.type = "button";
    button.textContent = `Load next ${MESSAGE_PAGE_SIZE} messages`;
    button.disabled = state.readerLoading;
    button.addEventListener("click", () => loadSession(state.selectedSessionId, { append: true }));
    footer.append(note, button);
  } else {
    footer.textContent = state.readerMessages.length ? "End of transcript." : "No transcript messages found.";
  }
  fragment.appendChild(footer);

  els.messageList.replaceChildren(fragment);
}

function updateTranscriptNotice(session, mode) {
  if (!session) {
    els.transcriptNotice.classList.add("hidden");
    return;
  }

  const loaded = state.readerMessages.length;
  const large = isLargeSession(session);
  const shouldShow = large || state.readerHasMore || mode === "loading" || mode === "append-loading";

  if (!shouldShow) {
    els.transcriptNotice.classList.add("hidden");
    return;
  }

  els.transcriptNotice.classList.remove("hidden");
  els.loadMoreMessagesButton.classList.toggle("hidden", !state.readerHasMore || state.readerLoading);
  els.loadMoreMessagesButton.disabled = state.readerLoading;

  if (mode === "loading") {
    els.transcriptNoticeTitle.textContent = large ? "Large transcript" : "Loading transcript";
    els.transcriptNoticeText.textContent = large
      ? `${sessionLoadNote(session)} The first chunk is loading now.`
      : "Transcript is loading locally.";
    return;
  }

  if (mode === "append-loading") {
    els.transcriptNoticeTitle.textContent = "Loading next chunk";
    els.transcriptNoticeText.textContent = `Keeping the page responsive while adding messages ${formatNumber(loaded + 1)} to ${formatNumber(loaded + MESSAGE_PAGE_SIZE)}.`;
    return;
  }

  if (state.readerHasMore) {
    els.transcriptNoticeTitle.textContent = large ? "Large transcript loaded safely" : "More messages available";
    els.transcriptNoticeText.textContent = `${formatNumber(loaded)} messages are shown. ${sessionLoadNote(session) || "Load another chunk to continue."}`;
    return;
  }

  els.transcriptNoticeTitle.textContent = "Transcript loaded";
  els.transcriptNoticeText.textContent = large
    ? `${formatNumber(loaded)} messages loaded in chunks to avoid blocking the interface.`
    : `${formatNumber(loaded)} messages loaded.`;
}

async function runDeepSearch() {
  const query = state.filter.trim();
  if (!query) {
    showToast("Type a search term first.");
    return;
  }

  showToast("Deep search is reading transcripts locally...");
  const params = new URLSearchParams({ q: query });
  if (state.selectedProvider !== "all") params.set("provider", state.selectedProvider);
  if (state.selectedProjectId !== "all") params.set("projectId", state.selectedProjectId);
  const payload = await fetchJson(`/api/search?${params.toString()}`);

  els.sessionList.replaceChildren();
  els.sessionCount.textContent = formatNumber(payload.results.length);
  els.activeProjectName.textContent = "Deep search results";
  els.activeProjectPath.textContent = query;

  if (!payload.results.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No transcript matches found.";
    els.sessionList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const result of payload.results) {
    const button = document.createElement("button");
    button.className = "session-item";
    button.type = "button";
    button.addEventListener("click", () => loadSession(result.sessionId));

    const title = document.createElement("div");
    title.className = "session-title";
    const strong = document.createElement("strong");
    strong.textContent = result.title || "Untitled session";
    const time = document.createElement("span");
    time.textContent = formatTime(result.timestamp);
    title.append(strong, time);

    const preview = document.createElement("p");
    preview.className = "session-preview";
    preview.textContent = result.snippet;

    const meta = document.createElement("div");
    meta.className = "meta-row";
    meta.appendChild(providerBadge(result.provider));
    meta.appendChild(tinyBadge(result.projectName));
    meta.appendChild(tinyBadge(result.role));
    if (result.lineNumber) meta.appendChild(tinyBadge(`line ${result.lineNumber}`));

    button.append(title, preview, meta);
    fragment.appendChild(button);
  }
  els.sessionList.appendChild(fragment);
  showToast(`Found ${payload.results.length} transcript match(es).`);
}

async function copyText(text, fallback) {
  const value = text || fallback || "";
  if (!value) {
    showToast("Nothing to copy.");
    return;
  }
  await navigator.clipboard.writeText(value);
  showToast("Copied.");
}

function setExportMenu(open) {
  state.exportMenuOpen = Boolean(open);
  els.exportMenu.classList.toggle("hidden", !state.exportMenuOpen);
  els.exportButton.setAttribute("aria-expanded", String(state.exportMenuOpen));
}

function updateExportControls() {
  const disabled = !state.selectedSessionId || !state.readerSession || state.readerLoading || state.exportLoading;
  els.exportButton.disabled = disabled;
  els.exportButton.textContent = state.exportLoading ? "Exporting..." : "Export";
  els.exportMarkdownButton.disabled = disabled;
  els.exportJsonButton.disabled = disabled;
  if (disabled) setExportMenu(false);
}

function filenameFromDisposition(disposition, fallback) {
  const quoted = /filename="([^"]+)"/i.exec(disposition || "");
  if (quoted?.[1]) return quoted[1];
  const plain = /filename=([^;]+)/i.exec(disposition || "");
  return plain?.[1]?.trim() || fallback;
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function exportCurrentSession(format) {
  if (!state.selectedSessionId) {
    showToast("Open a session first.");
    return;
  }

  state.exportLoading = true;
  setExportMenu(false);
  updateExportControls();
  showToast(state.readerHasMore ? "Preparing full transcript export..." : "Preparing export...");

  try {
    const params = new URLSearchParams({ format });
    const response = await fetch(`/api/export/session/${encodeURIComponent(state.selectedSessionId)}?${params.toString()}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Export failed: ${response.status}`);
    }
    const blob = await response.blob();
    const fallback = format === "json" ? "chat-export.json" : "chat-export.md";
    const filename = filenameFromDisposition(response.headers.get("content-disposition"), fallback);
    downloadBlob(blob, filename);
    showToast(`${format === "json" ? "JSON" : "Markdown"} export downloaded.`);
  } finally {
    state.exportLoading = false;
    updateExportControls();
  }
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => els.toast.classList.remove("visible"), 2400);
}

els.filterInput.addEventListener("input", (event) => {
  state.filter = event.target.value;
  state.sessionLimit = 120;
  renderProjects();
  renderSessions();
});

els.refreshButton.addEventListener("click", () => {
  loadIndex(true).catch((error) => showToast(error.message));
});

els.deepSearchButton.addEventListener("click", () => {
  runDeepSearch().catch((error) => showToast(error.message));
});

els.loadMoreMessagesButton.addEventListener("click", () => {
  if (!state.readerHasMore || state.readerLoading || !state.selectedSessionId) return;
  loadSession(state.selectedSessionId, { append: true }).catch((error) => showToast(error.message));
});

els.exportButton.addEventListener("click", (event) => {
  event.stopPropagation();
  if (els.exportButton.disabled) return;
  setExportMenu(!state.exportMenuOpen);
});

els.exportMarkdownButton.addEventListener("click", () => {
  exportCurrentSession("markdown").catch((error) => showToast(error.message));
});

els.exportJsonButton.addEventListener("click", () => {
  exportCurrentSession("json").catch((error) => showToast(error.message));
});

document.addEventListener("click", (event) => {
  if (!state.exportMenuOpen) return;
  if (event.target instanceof Element && event.target.closest(".export-menu")) return;
  setExportMenu(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.exportMenuOpen) setExportMenu(false);
});

els.copyResumeButton.addEventListener("click", () => {
  copyText(state.readerSession?.resumeCommand, "");
});

els.copyPathButton.addEventListener("click", () => {
  copyText(state.readerSession?.sourcePath, state.readerSession?.projectPath);
});

loadIndex(false).catch((error) => {
  showToast(error.message);
});
