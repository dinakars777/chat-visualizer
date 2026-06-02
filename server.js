const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const readline = require("readline");
const { execFile } = require("child_process");

const HOME = os.homedir();
const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");
const JSON_LIMIT_BYTES = 2 * 1024 * 1024;
const SEARCH_RESULT_LIMIT = 160;
const EXPORT_PAGE_SIZE = 400;

const providerConfig = {
  codex: {
    label: "Codex",
    color: "#155eef"
  },
  claude: {
    label: "Claude Code",
    color: "#9a3412"
  },
  cursor: {
    label: "Cursor",
    color: "#0f766e"
  },
  grok: {
    label: "Grok Build",
    color: "#7c3aed"
  },
  antigravity: {
    label: "Antigravity",
    color: "#b42318"
  }
};

const state = {
  cache: null,
  status: "idle",
  error: null,
  promise: null
};

function expandHome(...segments) {
  return path.join(HOME, ...segments);
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function stableId(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function walkFiles(root, predicate, limit = 5000) {
  const files = [];
  if (!fileExists(root)) return files;
  const stack = [root];

  while (stack.length && files.length < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && predicate(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  return files.sort((a, b) => {
    const aStat = safeStat(a);
    const bStat = safeStat(b);
    return (bStat?.mtimeMs || 0) - (aStat?.mtimeMs || 0);
  });
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, run);
  await Promise.all(workers);
  return results;
}

function parseJsonMaybe(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parseTimestamp(value) {
  if (!value) return null;
  if (typeof value === "number") {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimestamp(value, fallbackMs) {
  return parseTimestamp(value) || fallbackMs || Date.now();
}

function projectNameFromPath(projectPath) {
  if (!projectPath) return "Unknown project";
  const clean = projectPath.replace(/\/$/, "");
  return path.basename(clean) || clean;
}

function decodeClaudeProjectFolder(folderName) {
  if (!folderName.startsWith("-")) return folderName;
  return folderName.replace(/-/g, "/");
}

function decodeGrokProjectFolder(folderName) {
  try {
    return decodeURIComponent(folderName);
  } catch {
    return folderName;
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function textFromUnknown(value, depth = 0) {
  if (depth > 5 || value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => textFromUnknown(item, depth + 1)).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (typeof value.value === "string") return value.value;
    if (typeof value.markdown === "string") return value.markdown;
    if (value.type === "tool_use") {
      return `[tool use] ${value.name || "tool"}`;
    }
    if (value.type === "tool_result") {
      return `[tool result] ${textFromUnknown(value.content, depth + 1)}`;
    }
    if (value.type === "image" || value.type === "image_url") return "[image]";
    const prioritized = ["message", "summary", "input", "output", "arguments"];
    return prioritized
      .map((key) => textFromUnknown(value[key], depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function truncate(text, length = 240) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= length) return clean;
  return `${clean.slice(0, length - 1)}...`;
}

function titleFromText(text, fallback = "Untitled session") {
  const clean = String(text || "")
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.replace(/^#+\s*/, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(clean || fallback, 88);
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

function fileUriToPath(value) {
  if (!value || typeof value !== "string") return "";
  if (!value.startsWith("file://")) return value;
  try {
    const url = new URL(value);
    return decodeURIComponent(url.pathname);
  } catch {
    return value.replace(/^file:\/\//, "");
  }
}

function readProtoVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let position = offset;
  while (position < buffer.length) {
    const byte = buffer[position];
    position += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [Number(value), position];
    shift += 7n;
  }
  throw new Error("Invalid protobuf varint");
}

function readProtoFields(buffer) {
  const fields = [];
  let position = 0;

  while (position < buffer.length) {
    const [key, afterKey] = readProtoVarint(buffer, position);
    position = afterKey;
    const field = key >> 3;
    const wire = key & 7;
    const item = { field, wire };

    if (wire === 0) {
      [item.value, position] = readProtoVarint(buffer, position);
    } else if (wire === 1) {
      item.value = buffer.readDoubleLE(position);
      position += 8;
    } else if (wire === 2) {
      const [length, afterLength] = readProtoVarint(buffer, position);
      position = afterLength;
      item.bytes = buffer.slice(position, position + length);
      position += length;
      const text = item.bytes.toString("utf8");
      if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) item.string = text;
    } else if (wire === 5) {
      item.value = buffer.readFloatLE(position);
      position += 4;
    } else {
      break;
    }
    fields.push(item);
  }

  return fields;
}

function protoField(fields, fieldNumber) {
  return fields.find((field) => field.field === fieldNumber);
}

function protoString(fields, fieldNumber) {
  return protoField(fields, fieldNumber)?.string || "";
}

function protoNestedFields(fields, fieldNumber) {
  const field = protoField(fields, fieldNumber);
  if (!field?.bytes?.length) return [];
  try {
    return readProtoFields(field.bytes);
  } catch {
    return [];
  }
}

function protoTimestampMs(fields, fieldNumber) {
  const nested = protoNestedFields(fields, fieldNumber);
  const seconds = protoField(nested, 1)?.value;
  const nanos = protoField(nested, 2)?.value || 0;
  if (!Number.isFinite(seconds)) return null;
  return seconds * 1000 + Math.floor(nanos / 1_000_000);
}

function detectSensitive(text) {
  const clean = String(text || "");
  const findings = [];
  const patterns = [
    ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
    ["api key", /\b(?:sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
    ["aws key", /\bAKIA[0-9A-Z]{16}\b/g],
    ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
    ["token", /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\b\s*[:=]/gi]
  ];

  for (const [label, pattern] of patterns) {
    const matches = clean.match(pattern);
    if (matches?.length) findings.push({ label, count: matches.length });
  }

  return findings;
}

function mergeFindings(target, findings) {
  for (const finding of findings) {
    target[finding.label] = (target[finding.label] || 0) + finding.count;
  }
}

function providerLabel(provider) {
  return providerConfig[provider]?.label || provider;
}

function buildProjectId(projectPath, provider) {
  return stableId(`${projectPath || "unknown"}:${provider || "mixed"}`);
}

function createSessionBase(provider, sourcePath, stat) {
  return {
    id: stableId(`${provider}:${sourcePath}`),
    provider,
    providerLabel: providerLabel(provider),
    sourcePath,
    projectPath: "",
    projectName: "Unknown project",
    title: "",
    subtitle: "",
    createdAt: stat?.birthtimeMs || stat?.ctimeMs || stat?.mtimeMs || Date.now(),
    updatedAt: stat?.mtimeMs || Date.now(),
    fileSize: stat?.size || 0,
    messageCount: 0,
    userCount: 0,
    assistantCount: 0,
    toolCount: 0,
    sensitiveCount: 0,
    sensitiveKinds: {},
    firstUserText: "",
    lastMessageText: "",
    model: "",
    cwd: "",
    archived: false,
    sourceKind: "jsonl",
    resumeCommand: "",
    canOpenRaw: Boolean(sourcePath)
  };
}

function normalizeParseOptions(options) {
  if (typeof options === "boolean") {
    return {
      includeMessages: options,
      offset: 0,
      limit: Number.POSITIVE_INFINITY
    };
  }
  return {
    includeMessages: Boolean(options?.includeMessages),
    offset: Math.max(0, Number(options?.offset || 0)),
    limit: Math.max(1, Math.min(400, Number(options?.limit || 80)))
  };
}

async function parseJsonlFile(filePath, provider, options = false) {
  const parseOptions = normalizeParseOptions(options);
  const stat = safeStat(filePath);
  const session = createSessionBase(provider, filePath, stat);
  const messages = [];
  let lineNumber = 0;
  let hasMore = false;
  const maxIndexLines = parseOptions.includeMessages ? Number.POSITIVE_INFINITY : 35;
  session._messageOffset = parseOptions.offset;
  session._messageLimit = parseOptions.limit;

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (provider === "codex") {
      applyCodexEvent(session, messages, event, lineNumber, parseOptions.includeMessages);
    } else if (provider === "claude") {
      applyClaudeEvent(session, messages, event, lineNumber, parseOptions.includeMessages);
    } else if (provider === "grok") {
      applyGrokEvent(session, messages, event, lineNumber, parseOptions.includeMessages);
    }

    if (parseOptions.includeMessages && Number.isFinite(parseOptions.limit) && session.messageCount > parseOptions.offset + parseOptions.limit) {
      hasMore = true;
      rl.close();
      stream.destroy();
      break;
    }

    if (!parseOptions.includeMessages && lineNumber >= maxIndexLines) {
      session.indexSampled = true;
      rl.close();
      stream.destroy();
      break;
    }
  }

  session.projectPath = firstNonEmpty(session.cwd, inferProjectFromSource(provider, filePath));
  session.projectName = projectNameFromPath(session.projectPath);
  session.title = firstNonEmpty(session.title, titleFromText(session.firstUserText, ""), path.basename(filePath, ".jsonl"));
  session.subtitle = firstNonEmpty(session.subtitle, session.lastMessageText, session.sourcePath);
  session.createdAt = Math.min(session.createdAt, session.updatedAt);

  if (provider === "codex") {
    session.archived = filePath.includes(`${path.sep}archived_sessions${path.sep}`);
    session.resumeCommand = session.nativeSessionId ? `codex resume ${session.nativeSessionId}` : "";
  }

  if (provider === "claude") {
    const sessionId = session.nativeSessionId || path.basename(filePath, ".jsonl");
    session.nativeSessionId = sessionId;
    session.resumeCommand = `claude --resume ${sessionId}`;
  }

  delete session._messageOffset;
  delete session._messageLimit;

  return parseOptions.includeMessages
    ? {
        session,
        messages,
        page: {
          offset: parseOptions.offset,
          limit: parseOptions.limit,
          returned: messages.length,
          hasMore
        }
      }
    : session;
}

function inferProjectFromSource(provider, filePath) {
  if (provider !== "claude") return "";
  const parts = filePath.split(path.sep);
  const projectsIndex = parts.lastIndexOf("projects");
  if (projectsIndex >= 0 && parts[projectsIndex + 1]) {
    return decodeClaudeProjectFolder(parts[projectsIndex + 1]);
  }
  return "";
}

function applyCodexEvent(session, messages, event, lineNumber, includeMessages) {
  const payload = event.payload || {};
  const timestamp = normalizeTimestamp(event.timestamp || payload.timestamp, session.updatedAt);
  session.updatedAt = Math.max(session.updatedAt, timestamp);
  session.createdAt = Math.min(session.createdAt, timestamp);

  if (event.type === "session_meta") {
    session.nativeSessionId = payload.id || session.nativeSessionId;
    session.cwd = firstNonEmpty(payload.cwd, session.cwd);
    session.projectPath = firstNonEmpty(payload.cwd, session.projectPath);
    session.model = firstNonEmpty(payload.model, session.model);
    session.subtitle = firstNonEmpty(payload.originator, payload.source, session.subtitle);
    return;
  }

  if (event.type === "turn_context") {
    session.cwd = firstNonEmpty(payload.cwd, session.cwd);
    session.model = firstNonEmpty(payload.model, session.model);
    return;
  }

  if (event.type !== "response_item" && event.type !== "event_msg") return;

  let role = payload.role || "";
  let text = "";
  let kind = payload.type || event.type;
  let title = "";

  if (event.type === "response_item") {
    if (payload.type === "function_call") {
      role = "tool";
      kind = "tool_call";
      title = payload.name || "tool call";
      text = payload.arguments ? `${payload.name || "tool"} ${truncate(payload.arguments, 500)}` : title;
      session.toolCount += 1;
    } else if (payload.type === "function_call_output") {
      role = "tool";
      kind = "tool_result";
      title = "tool output";
      text = textFromUnknown(payload.output);
      session.toolCount += 1;
    } else {
      text = textFromUnknown(payload.content || payload.summary || payload.output);
    }
  } else if (event.type === "event_msg") {
    role = "system";
    text = textFromUnknown(payload.message || payload.text_elements || payload.info);
  }

  if (!text && !title) return;
  addMessage(session, messages, {
    role: normalizeRole(role),
    kind,
    text,
    title,
    timestamp,
    lineNumber
  }, includeMessages);
}

function applyClaudeEvent(session, messages, event, lineNumber, includeMessages) {
  const timestamp = normalizeTimestamp(event.timestamp, session.updatedAt);
  session.updatedAt = Math.max(session.updatedAt, timestamp);
  session.createdAt = Math.min(session.createdAt, timestamp);
  session.nativeSessionId = event.sessionId || session.nativeSessionId;
  session.cwd = firstNonEmpty(event.cwd, session.cwd);

  if (event.type === "ai-title") {
    session.title = firstNonEmpty(event.aiTitle, session.title);
    return;
  }

  let role = event.type;
  let kind = event.type;
  let text = "";
  let title = "";

  if (event.type === "user" || event.type === "assistant") {
    const message = event.message || {};
    role = normalizeRole(message.role || event.type);
    text = textFromUnknown(message.content || event.content || message);
  } else if (event.type === "system") {
    role = "system";
    text = textFromUnknown(event.content);
    title = event.subtype || "system";
  } else if (event.type === "summary") {
    role = "system";
    kind = "summary";
    text = textFromUnknown(event.summary || event.content);
  } else if (event.type === "queue-operation") {
    role = "system";
    title = event.operation || "queue";
    text = textFromUnknown(event.content || event.operation);
  }

  if (!text && !title) return;
  addMessage(session, messages, { role, kind, text, title, timestamp, lineNumber }, includeMessages);
}

function applyGrokEvent(session, messages, event, lineNumber, includeMessages) {
  const update = event.params?.update || event.update || event;
  const updateType = update.sessionUpdate || update.type || event.sessionUpdate || event.type || event.method || "message";
  const timestamp = normalizeTimestamp(update.timestamp || event.timestamp || update.created_at || update.createdAt, session.updatedAt);
  session.updatedAt = Math.max(session.updatedAt, timestamp);
  session.createdAt = Math.min(session.createdAt, timestamp);
  session.nativeSessionId = firstNonEmpty(update.sessionId, event.params?.sessionId, event.sessionId, session.nativeSessionId);
  session.cwd = firstNonEmpty(update.cwd, event.params?.cwd, event.cwd, session.cwd);
  session.model = firstNonEmpty(update.model, event.params?.model, event.model, session.model);

  let role = update.role || "";
  let kind = updateType;
  let text = "";
  let title = "";

  if (updateType === "agent_message_chunk" || updateType === "assistant_message" || updateType === "assistant") {
    role = "assistant";
    text = textFromUnknown(update.content || update.message || update.text || update.delta);
  } else if (updateType === "user_message_chunk" || updateType === "user_message" || updateType === "prompt" || updateType === "user") {
    role = "user";
    text = textFromUnknown(update.content || update.message || update.prompt || update.text);
  } else if (updateType === "agent_thought_chunk" || updateType === "thought") {
    role = "system";
    kind = "thought";
    title = "thought";
    text = textFromUnknown(update.content || update.message || update.text);
  } else if (updateType === "tool_call" || updateType === "tool_call_update" || updateType === "tool_result") {
    role = "tool";
    kind = updateType === "tool_result" ? "tool_result" : "tool_call";
    title = firstNonEmpty(update.tool?.name, update.tool, update.name, update.title, "tool call");
    text = textFromUnknown(update.arguments || update.input || update.output || update.content || update.tool || update);
  } else if (updateType === "plan") {
    role = "system";
    title = "plan";
    text = textFromUnknown(update.entries || update.content || update.plan || update);
  } else {
    role = normalizeRole(role || updateType);
    text = textFromUnknown(update.content || update.message || update.text || update.delta || update);
  }

  if (!text && !title) return;
  addMessage(session, messages, { role: normalizeRole(role), kind, text, title, timestamp, lineNumber }, includeMessages);
}

function antigravityArtifactFiles(brainDir) {
  if (!brainDir || !fileExists(brainDir)) return [];
  return walkFiles(brainDir, (file) => {
    const relative = path.relative(brainDir, file);
    if (relative.includes(`${path.sep}browser${path.sep}`)) return false;
    if (file.endsWith(".resolved")) return false;
    if (file.endsWith(".metadata.json")) return true;
    return file.endsWith(".md");
  }, 300).sort((a, b) => {
    const aStat = safeStat(a);
    const bStat = safeStat(b);
    return (aStat?.mtimeMs || 0) - (bStat?.mtimeMs || 0);
  });
}

function readAntigravityMetadata(filePath) {
  const metadata = readJsonFile(filePath);
  if (!metadata) return null;
  return {
    path: filePath,
    summary: firstNonEmpty(metadata.summary),
    artifactType: firstNonEmpty(metadata.artifactType),
    updatedAt: parseTimestamp(metadata.updatedAt)
  };
}

function addAntigravityArtifactMessages(session, messages, brainDir, includeMessages) {
  const files = antigravityArtifactFiles(brainDir);
  for (const file of files) {
    const stat = safeStat(file);
    const basename = path.basename(file);
    let text = "";
    let title = basename;
    let kind = "artifact";

    if (file.endsWith(".metadata.json")) {
      const metadata = readAntigravityMetadata(file);
      if (!metadata?.summary) continue;
      text = metadata.summary;
      title = `${basename.replace(".metadata.json", "")} summary`;
      kind = metadata.artifactType || "artifact_summary";
    } else {
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
    }

    addMessage(session, messages, {
      role: file.endsWith(".metadata.json") ? "system" : "assistant",
      kind,
      title,
      text,
      timestamp: parseTimestamp(readAntigravityMetadata(`${file}.metadata.json`)?.updatedAt) || stat?.mtimeMs || session.updatedAt,
      lineNumber: files.indexOf(file) + 1
    }, includeMessages);
  }
}

function decodeAntigravityTrajectorySummaries(rawValue) {
  if (!rawValue || typeof rawValue !== "string") return [];
  let topFields = [];
  try {
    topFields = readProtoFields(Buffer.from(rawValue, "base64"));
  } catch {
    return [];
  }

  const summaries = [];
  for (const entryField of topFields.filter((field) => field.field === 1 && field.bytes?.length)) {
    let entryFields = [];
    try {
      entryFields = readProtoFields(entryField.bytes);
    } catch {
      continue;
    }

    const nativeSessionId = protoString(entryFields, 1);
    const encodedSummary = protoString(protoNestedFields(entryFields, 2), 1);
    if (!nativeSessionId || !encodedSummary) continue;

    let summaryFields = [];
    try {
      summaryFields = readProtoFields(Buffer.from(encodedSummary, "base64"));
    } catch {
      continue;
    }

    const workspaceFields = protoNestedFields(summaryFields, 9);
    const projectPath = fileUriToPath(protoString(workspaceFields, 1));
    const createdAt = protoTimestampMs(summaryFields, 7);
    const updatedAt = Math.max(
      createdAt || 0,
      protoTimestampMs(summaryFields, 3) || 0,
      protoTimestampMs(summaryFields, 10) || 0
    ) || null;

    summaries.push({
      nativeSessionId,
      title: protoString(summaryFields, 1),
      projectPath,
      createdAt,
      updatedAt,
      sourceMessageHint: protoField(summaryFields, 2)?.value || 0,
      agentSessionId: protoString(summaryFields, 4)
    });
  }

  return summaries;
}

function normalizeRole(role) {
  if (role === 1 || role === "1") return "user";
  if (role === 2 || role === "2") return "assistant";
  if (role === "assistant" || role === "ai") return "assistant";
  if (role === "user" || role === "human") return "user";
  if (role === "tool" || role === "function") return "tool";
  return role || "system";
}

function addMessage(session, messages, message, includeMessages) {
  const sequence = session.messageCount + 1;
  const text = String(message.text || "");
  const displayText = text || message.title || "";
  const findings = detectSensitive(text);

  session.messageCount += 1;
  if (message.role === "user") {
    session.userCount += 1;
    if (!session.firstUserText) session.firstUserText = truncate(displayText, 180);
  } else if (message.role === "assistant") {
    session.assistantCount += 1;
  }
  if (message.role === "tool") {
    session.toolCount += 1;
  }

  if (displayText) session.lastMessageText = truncate(displayText, 220);
  if (findings.length) {
    session.sensitiveCount += findings.reduce((sum, finding) => sum + finding.count, 0);
    mergeFindings(session.sensitiveKinds, findings);
  }

  const offset = session._messageOffset || 0;
  const limit = session._messageLimit || Number.POSITIVE_INFINITY;

  if (includeMessages && sequence > offset && messages.length < limit) {
    messages.push({
      id: `${session.id}-${message.lineNumber || messages.length}`,
      role: message.role,
      kind: message.kind || message.role,
      title: message.title || "",
      text,
      preview: truncate(displayText, 400),
      timestamp: message.timestamp,
      lineNumber: message.lineNumber || messages.length + 1,
      sensitive: findings
    });
  }
}

async function sqliteJson(dbPath, query) {
  if (!fileExists(dbPath)) return [];
  return new Promise((resolve) => {
    execFile("sqlite3", ["-json", dbPath, query], { maxBuffer: 50 * 1024 * 1024 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve([]);
        return;
      }
      resolve(parseJsonMaybe(stdout) || []);
    });
  });
}

async function loadCursorRows() {
  const globalDb = expandHome("Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  const workspaceRoot = expandHome("Library", "Application Support", "Cursor", "User", "workspaceStorage");
  const workspaceDbs = walkFiles(workspaceRoot, (file) => path.basename(file) === "state.vscdb", 200);
  const dbs = [globalDb, ...workspaceDbs].filter((db, index, all) => fileExists(db) && all.indexOf(db) === index);
  const rows = [];

  for (const dbPath of dbs) {
    const query = [
      "select 'ItemTable' as tableName, key, cast(value as text) as value from ItemTable",
      "where key like 'composerData:%' or key = 'composer.composerHeaders' or key = 'composer.composerData' or key like 'bubbleId:%'",
      "union all",
      "select 'cursorDiskKV' as tableName, key, cast(value as text) as value from cursorDiskKV",
      "where key like 'composerData:%' or key = 'composer.composerHeaders' or key = 'composer.composerData' or key like 'bubbleId:%'"
    ].join(" ");
    const dbRows = await sqliteJson(dbPath, query);
    rows.push(...dbRows.map((row) => ({ ...row, dbPath })));
  }

  return rows;
}

async function scanCursorSessions() {
  const rows = await loadCursorRows();
  const composers = new Map();
  const bubbles = new Map();
  const headers = new Map();

  for (const row of rows) {
    const parsed = parseJsonMaybe(row.value);
    if (!parsed) continue;

    if (row.key === "composer.composerHeaders" && Array.isArray(parsed.allComposers)) {
      for (const header of parsed.allComposers) {
        if (header?.composerId) headers.set(header.composerId, header);
      }
      continue;
    }

    if (row.key.startsWith("composerData:") && parsed.composerId) {
      composers.set(parsed.composerId, { data: parsed, sourcePath: row.dbPath });
      continue;
    }

    if (row.key.startsWith("bubbleId:") && parsed.bubbleId) {
      const [, composerId, bubbleId] = row.key.split(":");
      if (composerId && bubbleId) {
        bubbles.set(`${composerId}:${bubbleId}`, parsed);
      }
    }
  }

  const sessions = [];
  for (const [composerId, { data, sourcePath }] of composers) {
    const stat = safeStat(sourcePath);
    const header = headers.get(composerId) || {};
    const session = createSessionBase("cursor", sourcePath, stat);
    session.id = stableId(`cursor:${composerId}`);
    session.nativeSessionId = composerId;
    session.sourceKind = "sqlite";
    session.title = titleFromText(firstNonEmpty(header.name, data.name, data.text), `Cursor composer ${composerId.slice(0, 8)}`);
    session.subtitle = firstNonEmpty(header.subtitle, data.subtitle, data.forceMode, data.unifiedMode);
    session.model = data.modelConfig?.modelName || "";
    session.createdAt = normalizeTimestamp(data.createdAt || header.createdAt, session.createdAt);
    session.updatedAt = Math.max(session.createdAt, stat?.mtimeMs || session.createdAt);
    session.projectPath = firstNonEmpty(
      data.workspaceIdentifier?.uri?.fsPath,
      header.workspaceIdentifier?.uri?.fsPath,
      data.workspaceIdentifier?.uri?.path,
      header.workspaceIdentifier?.uri?.path
    );
    session.projectName = projectNameFromPath(session.projectPath);
    session.resumeCommand = session.projectPath ? `cursor "${session.projectPath}"` : "";

    const messageHeaders = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];
    for (let index = 0; index < messageHeaders.length; index += 1) {
      const headerItem = messageHeaders[index] || {};
      const bubble = bubbles.get(`${composerId}:${headerItem.bubbleId}`) || {};
      const role = normalizeRole(headerItem.type || bubble.type);
      const text = textFromUnknown(bubble.text || headerItem.text);
      if (!text.trim()) continue;
      addMessage(session, [], {
        role,
        kind: bubble.type || headerItem.type || role,
        text,
        timestamp: normalizeTimestamp(bubble.createdAt || headerItem.createdAt, session.createdAt),
        lineNumber: index + 1
      }, false);
    }

    session.title = firstNonEmpty(session.title, session.firstUserText, `Cursor composer ${composerId.slice(0, 8)}`);
    sessions.push(session);
  }

  return sessions;
}

async function loadCursorSession(sessionId, offset = 0, limit = 80, summary = null) {
  const rows = await loadCursorRows();
  let composer = null;
  let sourcePath = "";
  const bubbles = new Map();

  for (const row of rows) {
    const parsed = parseJsonMaybe(row.value);
    if (!parsed) continue;
    if (row.key.startsWith("composerData:") && stableId(`cursor:${parsed.composerId}`) === sessionId) {
      composer = parsed;
      sourcePath = row.dbPath;
    }
    if (row.key.startsWith("bubbleId:") && parsed.bubbleId) {
      const [, composerId, bubbleId] = row.key.split(":");
      bubbles.set(`${composerId}:${bubbleId}`, parsed);
    }
  }

  if (!composer) return null;
  const stat = safeStat(sourcePath);
  const session = createSessionBase("cursor", sourcePath, stat);
  session.id = sessionId;
  session.nativeSessionId = composer.composerId;
  session.title = titleFromText(firstNonEmpty(composer.name, composer.text), `Cursor composer ${composer.composerId.slice(0, 8)}`);
  session.subtitle = firstNonEmpty(composer.subtitle, composer.forceMode, composer.unifiedMode);
  session.model = composer.modelConfig?.modelName || "";
  session.createdAt = normalizeTimestamp(composer.createdAt, session.createdAt);
  session.projectPath = firstNonEmpty(composer.workspaceIdentifier?.uri?.fsPath, composer.workspaceIdentifier?.uri?.path);
  session.projectName = projectNameFromPath(session.projectPath);
  session.sourceKind = "sqlite";
  session.resumeCommand = session.projectPath ? `cursor "${session.projectPath}"` : "";
  session._messageOffset = offset;
  session._messageLimit = limit;

  const messages = [];
  const messageHeaders = Array.isArray(composer.fullConversationHeadersOnly) ? composer.fullConversationHeadersOnly : [];
  for (let index = 0; index < messageHeaders.length; index += 1) {
    const header = messageHeaders[index] || {};
    const bubble = bubbles.get(`${composer.composerId}:${header.bubbleId}`) || {};
    const text = textFromUnknown(bubble.text || header.text);
    if (!text.trim()) continue;
    addMessage(session, messages, {
      role: normalizeRole(header.type || bubble.type),
      kind: bubble.type || header.type || "message",
      text,
      timestamp: normalizeTimestamp(bubble.createdAt || header.createdAt, session.createdAt),
      lineNumber: index + 1
    }, true);
  }

  const hasMore = session.messageCount > offset + limit;
  delete session._messageOffset;
  delete session._messageLimit;
  const page = {
    offset,
    limit,
    returned: messages.length,
    hasMore
  };
  return {
    session: summary ? mergeDetailSession(summary, session, page) : session,
    messages,
    page
  };
}

function applyGrokSummary(session, summary, summaryPath) {
  const sessionDir = summaryPath ? path.dirname(summaryPath) : path.dirname(session.sourcePath);
  const encodedProject = path.basename(path.dirname(sessionDir));
  const nativeSessionId = firstNonEmpty(
    summary?.session_id,
    summary?.sessionId,
    summary?.id,
    path.basename(sessionDir)
  );
  const projectPath = firstNonEmpty(
    summary?.cwd,
    summary?.working_directory,
    summary?.workingDirectory,
    decodeGrokProjectFolder(encodedProject)
  );
  const parentSessionId = firstNonEmpty(summary?.parent_session_id, summary?.parentSessionId);
  const messageCount = Number(summary?.message_count || summary?.messageCount || 0);

  session.id = stableId(`grok:${nativeSessionId}:${sessionDir}`);
  session.nativeSessionId = nativeSessionId;
  session.grokSummaryPath = summaryPath || path.join(sessionDir, "summary.json");
  session.cwd = firstNonEmpty(projectPath, session.cwd);
  session.projectPath = firstNonEmpty(projectPath, session.projectPath);
  session.projectName = projectNameFromPath(session.projectPath);
  session.title = firstNonEmpty(summary?.title, session.title, session.firstUserText, `Grok session ${nativeSessionId.slice(0, 8)}`);
  session.subtitle = firstNonEmpty(
    summary?.subtitle,
    parentSessionId ? `Restored from ${parentSessionId.slice(0, 8)}` : "",
    session.subtitle,
    session.lastMessageText,
    session.sourcePath
  );
  session.model = firstNonEmpty(summary?.model, summary?.model_id, summary?.modelId, session.model);
  session.createdAt = normalizeTimestamp(summary?.created_at || summary?.createdAt, session.createdAt);
  session.updatedAt = normalizeTimestamp(summary?.updated_at || summary?.updatedAt, session.updatedAt);
  session.messageCount = Math.max(session.messageCount, Number.isFinite(messageCount) ? messageCount : 0);
  session.sourceKind = path.basename(session.sourcePath) === "updates.jsonl" ? "jsonl" : "json";
  session.resumeCommand = session.nativeSessionId
    ? `${session.projectPath ? `grok --cwd ${shellQuote(session.projectPath)} ` : "grok "}--resume ${shellQuote(session.nativeSessionId)}`
    : "";
  return session;
}

async function scanGrokSessions() {
  const root = expandHome(".grok", "sessions");
  const summaryFiles = walkFiles(root, (file) => path.basename(file) === "summary.json", 4000);

  const sessions = await mapLimit(summaryFiles, 16, async (summaryPath) => {
    const summary = readJsonFile(summaryPath);
    if (!summary) return null;
    const sessionDir = path.dirname(summaryPath);
    const updatesPath = path.join(sessionDir, "updates.jsonl");
    const sourcePath = fileExists(updatesPath) ? updatesPath : summaryPath;
    const stat = safeStat(sourcePath) || safeStat(summaryPath);

    try {
      const session = fileExists(updatesPath)
        ? await parseJsonlFile(updatesPath, "grok", false)
        : createSessionBase("grok", sourcePath, stat);
      return applyGrokSummary(session, summary, summaryPath);
    } catch {
      return applyGrokSummary(createSessionBase("grok", sourcePath, stat), summary, summaryPath);
    }
  });

  return sessions.filter(Boolean);
}

async function loadGrokSession(sessionId, offset = 0, limit = 80, summary = null) {
  const summaryPath = summary?.grokSummaryPath || "";
  const grokSummary = summaryPath ? readJsonFile(summaryPath) : null;
  const sourcePath = summary?.sourcePath || "";
  const hasUpdates = path.basename(sourcePath) === "updates.jsonl" && fileExists(sourcePath);

  if (!hasUpdates) {
    const stat = safeStat(sourcePath);
    const session = applyGrokSummary(createSessionBase("grok", sourcePath, stat), grokSummary || {}, summaryPath);
    const page = { offset, limit, returned: 0, hasMore: false };
    return {
      session: summary ? mergeDetailSession(summary, session, page) : session,
      messages: [],
      page
    };
  }

  const details = await parseJsonlFile(sourcePath, "grok", {
    includeMessages: true,
    offset,
    limit
  });
  details.session = applyGrokSummary(details.session, grokSummary || {}, summaryPath);
  details.session = summary ? mergeDetailSession(summary, details.session, details.page) : details.session;
  return details;
}

function antigravityBrainDir(nativeSessionId) {
  return expandHome(".gemini", "antigravity", "brain", nativeSessionId);
}

function createAntigravitySession(nativeSessionId, sourcePath, stat) {
  const session = createSessionBase("antigravity", sourcePath, stat);
  session.id = stableId(`antigravity:${nativeSessionId}`);
  session.nativeSessionId = nativeSessionId;
  session.sourceKind = "artifact-dir";
  return session;
}

function applyAntigravitySummary(session, summary = {}, brainDir = "") {
  session.nativeSessionId = summary.nativeSessionId || session.nativeSessionId;
  session.antigravityBrainDir = brainDir || antigravityBrainDir(session.nativeSessionId);
  session.projectPath = firstNonEmpty(summary.projectPath, session.projectPath, session.antigravityBrainDir);
  session.projectName = projectNameFromPath(session.projectPath);
  session.title = firstNonEmpty(summary.title, session.title, session.firstUserText, `Antigravity ${session.nativeSessionId.slice(0, 8)}`);
  session.subtitle = firstNonEmpty(session.subtitle, session.lastMessageText, session.sourcePath);
  session.createdAt = summary.createdAt || session.createdAt;
  session.updatedAt = Math.max(summary.updatedAt || 0, session.updatedAt || 0);
  session.resumeCommand = session.projectPath ? `open -a Antigravity ${shellQuote(session.projectPath)}` : "";
  return session;
}

function summarizeAntigravityBrain(nativeSessionId, summary = {}) {
  const brainDir = antigravityBrainDir(nativeSessionId);
  const stat = safeStat(brainDir);
  const session = applyAntigravitySummary(createAntigravitySession(nativeSessionId, brainDir, stat), summary, brainDir);
  addAntigravityArtifactMessages(session, [], brainDir, false);
  session.title = firstNonEmpty(summary.title, session.title, session.firstUserText, `Antigravity ${nativeSessionId.slice(0, 8)}`);
  session.subtitle = firstNonEmpty(session.subtitle, `${session.messageCount} local artifact record(s)`, session.sourcePath);
  return session;
}

async function loadAntigravityTrajectorySummaries() {
  const dbs = [
    expandHome("Library", "Application Support", "Antigravity", "User", "globalStorage", "state.vscdb"),
    expandHome("Library", "Application Support", "Antigravity IDE", "User", "globalStorage", "state.vscdb")
  ].filter(fileExists);
  const summaries = [];

  for (const dbPath of dbs) {
    const rows = await sqliteJson(dbPath, "select cast(value as text) as value from ItemTable where key = 'antigravityUnifiedStateSync.trajectorySummaries'");
    for (const row of rows) {
      summaries.push(...decodeAntigravityTrajectorySummaries(row.value).map((summary) => ({ ...summary, dbPath })));
    }
  }

  return summaries;
}

async function scanAntigravitySessions() {
  const summaries = await loadAntigravityTrajectorySummaries();
  const byId = new Map();

  for (const summary of summaries) {
    const brainDir = antigravityBrainDir(summary.nativeSessionId);
    const sourcePath = fileExists(brainDir) ? brainDir : summary.dbPath;
    const stat = safeStat(sourcePath);
    const session = summarizeAntigravityBrain(summary.nativeSessionId, summary);
    session.sourcePath = sourcePath;
    session.fileSize = stat?.size || 0;
    byId.set(summary.nativeSessionId, session);
  }

  const brainRoot = expandHome(".gemini", "antigravity", "brain");
  if (fileExists(brainRoot)) {
    for (const entry of fs.readdirSync(brainRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (byId.has(entry.name)) continue;
      const brainDir = path.join(brainRoot, entry.name);
      const files = antigravityArtifactFiles(brainDir);
      if (!files.length) continue;
      byId.set(entry.name, summarizeAntigravityBrain(entry.name, {}));
    }
  }

  return Array.from(byId.values());
}

async function loadAntigravitySession(sessionId, offset = 0, limit = 80, summary = null) {
  const nativeSessionId = summary?.nativeSessionId || "";
  if (!nativeSessionId) return null;
  const brainDir = summary?.antigravityBrainDir || antigravityBrainDir(nativeSessionId);
  const stat = safeStat(brainDir);
  const session = createAntigravitySession(nativeSessionId, brainDir, stat);
  const messages = [];
  session._messageOffset = offset;
  session._messageLimit = limit;
  applyAntigravitySummary(session, summary || {}, brainDir);
  addAntigravityArtifactMessages(session, messages, brainDir, true);
  delete session._messageOffset;
  delete session._messageLimit;

  const page = {
    offset,
    limit,
    returned: messages.length,
    hasMore: session.messageCount > offset + limit
  };

  return {
    session: summary ? mergeDetailSession(summary, session, page) : session,
    messages,
    page
  };
}

async function buildIndex() {
  state.status = "scanning";
  state.error = null;
  const startedAt = Date.now();
  const errors = [];

  const codexFiles = [
    ...walkFiles(expandHome(".codex", "sessions"), (file) => file.endsWith(".jsonl"), 4000),
    ...walkFiles(expandHome(".codex", "archived_sessions"), (file) => file.endsWith(".jsonl"), 4000)
  ];
  const claudeFiles = walkFiles(expandHome(".claude", "projects"), (file) => file.endsWith(".jsonl"), 4000);

  const sessions = [];

  const codexSessions = await mapLimit(codexFiles, 32, async (file) => {
    try {
      return await parseJsonlFile(file, "codex", false);
    } catch (error) {
      errors.push({ provider: "codex", sourcePath: file, message: error.message });
      return null;
    }
  });

  const claudeSessions = await mapLimit(claudeFiles, 32, async (file) => {
    try {
      return await parseJsonlFile(file, "claude", false);
    } catch (error) {
      errors.push({ provider: "claude", sourcePath: file, message: error.message });
      return null;
    }
  });

  sessions.push(...codexSessions.filter(Boolean), ...claudeSessions.filter(Boolean));

  try {
    sessions.push(...await scanCursorSessions());
  } catch (error) {
    errors.push({ provider: "cursor", sourcePath: "Cursor state.vscdb", message: error.message });
  }

  try {
    sessions.push(...await scanGrokSessions());
  } catch (error) {
    errors.push({ provider: "grok", sourcePath: "~/.grok/sessions", message: error.message });
  }

  try {
    sessions.push(...await scanAntigravitySessions());
  } catch (error) {
    errors.push({ provider: "antigravity", sourcePath: "~/.gemini/antigravity/brain", message: error.message });
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  const projects = buildProjects(sessions);
  const providers = buildProviders(sessions);
  const cache = {
    generatedAt: Date.now(),
    scanMs: Date.now() - startedAt,
    sessions,
    projects,
    providers,
    errors,
    stats: {
      sessions: sessions.length,
      projects: projects.length,
      messages: sessions.reduce((sum, item) => sum + item.messageCount, 0),
      sensitive: sessions.reduce((sum, item) => sum + item.sensitiveCount, 0)
    }
  };

  state.cache = cache;
  state.status = "ready";
  return cache;
}

function buildProviders(sessions) {
  return Object.entries(providerConfig).map(([id, config]) => {
    const providerSessions = sessions.filter((session) => session.provider === id);
    return {
      id,
      label: config.label,
      color: config.color,
      sessionCount: providerSessions.length,
      messageCount: providerSessions.reduce((sum, session) => sum + session.messageCount, 0),
      lastActivity: providerSessions[0]?.updatedAt || null
    };
  });
}

function buildProjects(sessions) {
  const byProject = new Map();
  for (const session of sessions) {
    const projectKey = session.projectPath || `${session.provider}:unknown`;
    const id = buildProjectId(projectKey, "mixed");
    if (!byProject.has(id)) {
      byProject.set(id, {
        id,
        name: projectNameFromPath(projectKey),
        path: projectKey,
        providers: [],
        sessionCount: 0,
        messageCount: 0,
        sensitiveCount: 0,
        indexSampled: false,
        lastActivity: 0,
        firstActivity: Number.POSITIVE_INFINITY,
        topSessionIds: []
      });
    }
    const project = byProject.get(id);
    if (!project.providers.includes(session.provider)) project.providers.push(session.provider);
    project.sessionCount += 1;
    project.messageCount += session.messageCount;
    project.sensitiveCount += session.sensitiveCount;
    project.indexSampled = project.indexSampled || Boolean(session.indexSampled);
    project.lastActivity = Math.max(project.lastActivity, session.updatedAt);
    project.firstActivity = Math.min(project.firstActivity, session.createdAt);
    if (project.topSessionIds.length < 6) project.topSessionIds.push(session.id);
  }

  return Array.from(byProject.values()).sort((a, b) => b.lastActivity - a.lastActivity);
}

async function ensureIndex(force = false) {
  if (!force && state.cache) return state.cache;
  if (state.promise) return state.promise;
  state.promise = buildIndex()
    .catch((error) => {
      state.status = "error";
      state.error = error.message;
      throw error;
    })
    .finally(() => {
      state.promise = null;
    });
  return state.promise;
}

async function loadSessionById(sessionId) {
  return loadSessionPageById(sessionId, 0, 80);
}

async function loadSessionPageById(sessionId, offset = 0, limit = 80) {
  const cache = await ensureIndex(false);
  const summary = cache.sessions.find((session) => session.id === sessionId);
  if (!summary) return null;
  if (summary.provider === "cursor") return loadCursorSession(sessionId, offset, limit, summary);
  if (summary.provider === "grok") return loadGrokSession(sessionId, offset, limit, summary);
  if (summary.provider === "antigravity") return loadAntigravitySession(sessionId, offset, limit, summary);
  const details = await parseJsonlFile(summary.sourcePath, summary.provider, {
    includeMessages: true,
    offset,
    limit
  });
  details.session = mergeDetailSession(summary, details.session, details.page);
  return details;
}

async function loadFullSessionById(sessionId) {
  let offset = 0;
  let session = null;
  const messages = [];

  while (true) {
    const details = await loadSessionPageById(sessionId, offset, EXPORT_PAGE_SIZE);
    if (!details) return null;
    session = details.session;
    const pageMessages = details.messages || [];
    messages.push(...pageMessages);

    const hasMore = Boolean(details.page?.hasMore || details.session?.hasMore);
    if (!hasMore) break;
    if (!pageMessages.length) break;
    offset += pageMessages.length;
  }

  return {
    session: {
      ...session,
      messageCount: Math.max(session?.messageCount || 0, messages.length),
      loadedCount: messages.length,
      loadedThrough: messages.length,
      hasMore: false,
      totalKnown: true
    },
    messages,
    page: {
      offset: 0,
      limit: messages.length,
      returned: messages.length,
      hasMore: false
    }
  };
}

function mergeDetailSession(summary, parsed, page) {
  const indexedTotalIsKnown = !summary.indexSampled && !page.hasMore;
  return {
    ...summary,
    ...parsed,
    messageCount: indexedTotalIsKnown ? Math.max(summary.messageCount, parsed.messageCount) : summary.messageCount,
    indexedMessageCount: summary.messageCount,
    loadedOffset: page.offset,
    loadedCount: page.returned,
    loadedThrough: page.offset + page.returned,
    hasMore: page.hasMore,
    totalKnown: indexedTotalIsKnown
  };
}

async function deepSearch(query, filters = {}) {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return [];
  const cache = await ensureIndex(false);
  const results = [];
  const sessions = cache.sessions.filter((session) => {
    if (filters.provider && session.provider !== filters.provider) return false;
    if (filters.projectId) {
      const projectId = buildProjectId(session.projectPath || `${session.provider}:unknown`, "mixed");
      if (projectId !== filters.projectId) return false;
    }
    return true;
  });

  const addResult = (result) => {
    if (results.length >= SEARCH_RESULT_LIMIT) return;
    const key = `${result.sessionId}:${result.lineNumber || "meta"}:${result.role}`;
    if (results.some((item) => `${item.sessionId}:${item.lineNumber || "meta"}:${item.role}` === key)) return;
    results.push(result);
  };

  for (const session of sessions) {
    const haystack = [
      session.title,
      session.subtitle,
      session.projectName,
      session.projectPath,
      session.firstUserText,
      session.lastMessageText
    ].join(" ").toLowerCase();

    if (haystack.includes(normalizedQuery)) {
      addResult({
        sessionId: session.id,
        provider: session.provider,
        projectName: session.projectName,
        title: session.title,
        timestamp: session.updatedAt,
        role: "session",
        snippet: snippetFromText(`${session.title} ${session.subtitle} ${session.firstUserText}`, normalizedQuery)
      });
    }
  }

  if (results.length) return results;

  const sessionByPath = new Map(sessions.filter((session) => session.sourceKind === "jsonl").map((session) => [session.sourcePath, session]));
  const roots = [
    expandHome(".codex", "sessions"),
    expandHome(".codex", "archived_sessions"),
    expandHome(".claude", "projects"),
    expandHome(".grok", "sessions")
  ].filter(fileExists);
  const rgHits = await ripgrepSearch(query, roots);

  for (const hit of rgHits) {
    if (results.length >= SEARCH_RESULT_LIMIT) break;
    const session = sessionByPath.get(hit.path);
    if (!session) continue;
    if (filters.provider && session.provider !== filters.provider) continue;
    if (filters.projectId) {
      const projectId = buildProjectId(session.projectPath || `${session.provider}:unknown`, "mixed");
      if (projectId !== filters.projectId) continue;
    }
    const text = extractSearchText(session.provider, hit.text) || hit.text;
    addResult({
      sessionId: session.id,
      provider: session.provider,
      projectName: session.projectName,
      title: session.title,
      timestamp: session.updatedAt,
      role: "transcript",
      lineNumber: hit.lineNumber,
      snippet: snippetFromText(text, normalizedQuery)
    });
  }

  for (const session of sessions.filter((item) => item.provider === "cursor" || item.provider === "antigravity")) {
    if (results.length >= SEARCH_RESULT_LIMIT) break;
    const details = session.provider === "cursor"
      ? await loadCursorSession(session.id)
      : await loadAntigravitySession(session.id, 0, 400, session);
    if (!details) continue;
    for (const message of details.messages) {
      const text = message.text || message.preview || "";
      if (!text.toLowerCase().includes(normalizedQuery)) continue;
      addResult({
        sessionId: session.id,
        provider: session.provider,
        projectName: session.projectName,
        title: session.title,
        timestamp: message.timestamp,
        role: message.role,
        lineNumber: message.lineNumber,
        snippet: snippetFromText(text, normalizedQuery)
      });
    }
  }

  return results;
}

async function ripgrepSearch(query, roots) {
  if (!roots.length) return [];
  return new Promise((resolve) => {
    const args = ["--json", "-i", "--fixed-strings", "--max-count", "6", "--glob", "*.jsonl", "--", query, ...roots];
    execFile("rg", args, { maxBuffer: 30 * 1024 * 1024, timeout: 8000 }, (error, stdout) => {
      if (error && error.code !== 1) {
        resolve([]);
        return;
      }
      const hits = [];
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const event = parseJsonMaybe(line);
        if (event?.type !== "match") continue;
        hits.push({
          path: event.data?.path?.text,
          lineNumber: event.data?.line_number,
          text: event.data?.lines?.text || ""
        });
        if (hits.length >= SEARCH_RESULT_LIMIT) break;
      }
      resolve(hits.filter((hit) => hit.path));
    });
  });
}

function extractSearchText(provider, line) {
  const event = parseJsonMaybe(line);
  if (!event) return "";
  if (provider === "codex") {
    const payload = event.payload || {};
    return textFromUnknown(payload.content || payload.message || payload.text_elements || payload.info || payload);
  }
  if (provider === "claude") {
    const message = event.message || {};
    return textFromUnknown(message.content || event.content || event.aiTitle || event.summary || event);
  }
  if (provider === "grok") {
    const update = event.params?.update || event.update || event;
    return textFromUnknown(update.content || update.message || update.text || update.arguments || update.output || update);
  }
  return textFromUnknown(event);
}

function snippetFromText(text, query) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const index = clean.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return truncate(clean, 220);
  const start = Math.max(0, index - 90);
  const end = Math.min(clean.length, index + query.length + 120);
  return `${start > 0 ? "..." : ""}${clean.slice(start, end)}${end < clean.length ? "..." : ""}`;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}

function sendDownload(res, text, contentType, filename) {
  const body = Buffer.from(text, "utf8");
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="${filename}"`,
    "content-length": body.length
  });
  res.end(body);
}

function filenameSlug(value, fallback = "chat") {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

function exportFilename(session, format) {
  const date = session?.updatedAt ? new Date(session.updatedAt).toISOString().slice(0, 10) : "undated";
  const provider = filenameSlug(session?.providerLabel || session?.provider, "session");
  const sessionId = filenameSlug(session?.id || session?.nativeSessionId, "chat").slice(0, 24);
  const extension = format === "json" ? "json" : "md";
  return `${provider}-${date}-${sessionId}.${extension}`;
}

function exportPayload(details) {
  return {
    exportedAt: new Date().toISOString(),
    formatVersion: 1,
    session: details.session,
    messages: details.messages
  };
}

function markdownHeading(value) {
  return String(value || "Untitled session").replace(/\r?\n/g, " ").trim() || "Untitled session";
}

function markdownLine(label, value) {
  const clean = String(value || "").replace(/\r?\n/g, " ").trim();
  return clean ? `- ${label}: ${clean}` : "";
}

function exportMarkdown(details) {
  const { session, messages } = details;
  const lines = [
    `# ${markdownHeading(session.title)}`,
    "",
    ...[
      markdownLine("Provider", session.providerLabel || session.provider),
      markdownLine("Project", session.projectPath || session.projectName),
      markdownLine("Updated", session.updatedAt ? new Date(session.updatedAt).toISOString() : ""),
      markdownLine("Model", session.model),
      markdownLine("Messages", String(messages.length)),
      markdownLine("Source", session.sourcePath),
      markdownLine("Exported", new Date().toISOString())
    ].filter(Boolean),
    "",
    "## Transcript",
    ""
  ];

  for (const [index, message] of messages.entries()) {
    const role = markdownHeading(message.role || "system");
    lines.push(`### ${index + 1}. ${role}`);
    if (message.timestamp || message.lineNumber) {
      const parts = [];
      if (message.timestamp) parts.push(new Date(message.timestamp).toISOString());
      if (message.lineNumber) parts.push(`line ${message.lineNumber}`);
      lines.push("");
      lines.push(`_${parts.join(" / ")}_`);
    }
    lines.push("");
    lines.push(String(message.text || message.title || "[empty]").trim() || "[empty]");
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function exportSession(sessionId, format) {
  const details = await loadFullSessionById(sessionId);
  if (!details) return null;
  if (format === "json") {
    return {
      filename: exportFilename(details.session, "json"),
      contentType: "application/json; charset=utf-8",
      body: `${JSON.stringify(exportPayload(details), null, 2)}\n`
    };
  }
  return {
    filename: exportFilename(details.session, "markdown"),
    contentType: "text/markdown; charset=utf-8",
    body: exportMarkdown(details)
  };
}

function serveStatic(req, res, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.normalize(path.join(PUBLIC_DIR, relativePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }
    const ext = path.extname(filePath);
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".svg": "image/svg+xml"
    }[ext] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store"
    });
    res.end(data);
  });
}

async function handleApi(req, res, url) {
  try {
    if (url.pathname === "/api/index") {
      const force = url.searchParams.get("refresh") === "1";
      const cache = await ensureIndex(force);
      sendJson(res, 200, {
        status: state.status,
        generatedAt: cache.generatedAt,
        scanMs: cache.scanMs,
        stats: cache.stats,
        providers: cache.providers,
        projects: cache.projects,
        sessions: cache.sessions,
        errors: cache.errors
      });
      return;
    }

    if (url.pathname === "/api/status") {
      sendJson(res, 200, {
        status: state.status,
        error: state.error,
        generatedAt: state.cache?.generatedAt || null,
        stats: state.cache?.stats || null
      });
      return;
    }

    if (url.pathname.startsWith("/api/export/session/")) {
      const sessionId = decodeURIComponent(url.pathname.slice("/api/export/session/".length));
      const requestedFormat = (url.searchParams.get("format") || "markdown").toLowerCase();
      const format = requestedFormat === "json" ? "json" : "markdown";
      const exported = await exportSession(sessionId, format);
      if (!exported) {
        sendJson(res, 404, { error: "Session not found" });
        return;
      }
      sendDownload(res, exported.body, exported.contentType, exported.filename);
      return;
    }

    if (url.pathname.startsWith("/api/session/")) {
      const sessionId = decodeURIComponent(url.pathname.split("/").pop());
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      const limit = Math.max(1, Math.min(400, Number(url.searchParams.get("limit") || 80)));
      const details = await loadSessionPageById(sessionId, offset, limit);
      if (!details) {
        sendJson(res, 404, { error: "Session not found" });
        return;
      }
      sendJson(res, 200, details);
      return;
    }

    if (url.pathname === "/api/search") {
      const q = url.searchParams.get("q") || "";
      const provider = url.searchParams.get("provider") || "";
      const projectId = url.searchParams.get("projectId") || "";
      const results = await deepSearch(q, { provider, projectId });
      sendJson(res, 200, { query: q, results });
      return;
    }

    sendJson(res, 404, { error: "Unknown API endpoint" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`ChatVisualizer running at http://127.0.0.1:${PORT}`);
  ensureIndex(false).catch((error) => {
    console.error(`Initial scan failed: ${error.message}`);
  });
});
