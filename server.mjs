import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, readdir, readlink, stat, access } from "node:fs/promises";
import { execFile } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "dist");
const PORT = Number(process.env.PORT || 8091);
const COLLECT_INTERVAL_MS = 10000;
const REPO_REFRESH_MS = 60000;
const STALE_AFTER_MS = 30000;
const MAX_HISTORY = 60;
const MAX_TRACES = 200;
const MAX_ERRORS = 20;
const MAX_REPOS = 250;
const MAX_API_RPS_WINDOW_MS = 10000;
const MAX_API_REQUESTS_PER_WINDOW = 60;
const HOME_ROOT = process.env.OBSERVE_ROOT || os.homedir();
const GIT_SCAN_ROOT = process.env.OBSERVE_REPO_SCAN_ROOT || HOME_ROOT;
const TMUX_LOG_DIR = process.env.OBSERVE_TMUX_LOG_DIR || path.join(HOME_ROOT, "tmux-logs");
const AGENTY_STATUS_LOG = process.env.OBSERVE_AGENTY_STATUS_LOG || path.join(HOME_ROOT, "agenty", "api", "status.log");
const CADDYFILE_PATH = process.env.OBSERVE_CADDYFILE || "/etc/caddy/Caddyfile";
const NGINX_SITES_ENABLED = process.env.OBSERVE_NGINX_SITES_ENABLED || "/etc/nginx/sites-enabled";
const NGINX_CONF_D = process.env.OBSERVE_NGINX_CONF_D || "/etc/nginx/conf.d";
const IGNORED_REPO_PREFIXES = (
  process.env.OBSERVE_IGNORED_REPO_PREFIXES ||
  [".asdf", ".tmux", ".codex", ".cache", ".npm"].map((segment) => path.join(HOME_ROOT, segment)).join(",")
)
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const PORTS_TO_PROBE = new Set([80, 7391, 8090, 8091, 8751, 8901, 17888, 31823]);
const STATIC_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".svg"]);
const apiRate = new Map();
const SIBLING_PATHS = {
  tmuxdesk: process.env.OBSERVE_TMUXDESK_PATH || path.join(HOME_ROOT, "tmuxdesk"),
  corporaInterfaces: process.env.OBSERVE_CORPORA_PATH || path.join(HOME_ROOT, "mornings", "corpora-interfaces"),
};

const state = {
  snapshot: null,
  traces: [],
  sequence: 0,
  revision: 0,
  lastRepoScanAt: 0,
  repoSnapshot: null,
  lastSuccessfulSnapshotAt: null,
  collector: {
    startedAt: new Date().toISOString(),
    lastCollectedAt: null,
    collecting: false,
    errors: [],
    lastDurationMs: null,
    consecutiveFailures: 0,
  },
};

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function toIsoNow() {
  return new Date().toISOString();
}

function securityHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none';",
  };
}

function commandResult(ok, stdout, stderr, code = 0, signal = null) {
  return {
    ok,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    code,
    signal,
  };
}

function execCommand(command, args = [], timeout = 8000, maxBuffer = 8 * 1024 * 1024) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        resolve(commandResult(false, stdout || "", stderr || error.message, error.code ?? 1, error.signal ?? null));
        return;
      }
      resolve(commandResult(true, stdout || "", stderr || ""));
    });
  });
}

function execBash(script, timeout = 15000) {
  return execCommand("bash", ["-lc", script], timeout);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "n/a";
  }

  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  return `${hours}h ${minutes}m`;
}

function appendTrace(section, msg, severity = "info") {
  const entry = {
    ts: Date.now(),
    section,
    msg,
    severity,
    seq: state.sequence++,
  };
  state.traces.unshift(entry);
  state.traces = state.traces.slice(0, MAX_TRACES);
}

function addSectionHistory(id, value) {
  if (!state.snapshot?.histories?.[id]) {
    return [value];
  }
  return [...state.snapshot.histories[id], value].slice(-MAX_HISTORY);
}

function diagnostic(ok, detail, extra = {}) {
  return {
    ok,
    detail,
    checkedAt: toIsoNow(),
    ...extra,
  };
}

function summarizeErrors() {
  return state.collector.errors.slice(0, 5);
}

function collectorStatusSummary() {
  const collectedAt = state.snapshot?.collectedAt || state.lastSuccessfulSnapshotAt;
  const stalenessMs = collectedAt ? Date.now() - Date.parse(collectedAt) : null;
  const healthy = state.collector.consecutiveFailures === 0;
  const ready = Boolean(collectedAt) && (stalenessMs === null || stalenessMs <= STALE_AFTER_MS * 2);
  return {
    healthy,
    ready,
    stalenessMs,
    consecutiveFailures: state.collector.consecutiveFailures,
    lastCollectedAt: state.collector.lastCollectedAt,
    lastSuccessfulSnapshotAt: state.lastSuccessfulSnapshotAt,
    lastDurationMs: state.collector.lastDurationMs,
  };
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function httpHeadProbe(port) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "HEAD",
        path: "/",
        timeout: 2000,
      },
      (response) => {
        const latencyMs = Date.now() - startedAt;
        const headline = `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage || ""}`.trim();
        response.resume();
        resolve({ ok: true, headline, latencyMs });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", (error) => {
      resolve({ ok: false, headline: error.message, latencyMs: Date.now() - startedAt });
    });
    request.end();
  });
}

async function collectDisk() {
  const result = await execCommand("df", ["-B1", "/"]);
  if (!result.ok || !result.stdout) {
    return { data: null, diag: diagnostic(false, result.stderr || "disk probe failed") };
  }

  const lines = result.stdout.split("\n").filter(Boolean);
  const line = lines[lines.length - 1];
  const parts = line.split(/\s+/);
  if (parts.length < 6) {
    return { data: null, diag: diagnostic(false, "disk probe returned malformed output") };
  }

  const total = Number(parts[1]);
  const used = Number(parts[2]);
  const avail = Number(parts[3]);
  const usePct = Number(parts[4].replace("%", "")) / 100;
  return {
    data: { total, used, avail, usePct },
    diag: diagnostic(true, `disk probe ok (${parts[0]})`),
  };
}

async function collectMemory() {
  const result = await execCommand("free", ["-b"]);
  if (!result.ok || !result.stdout) {
    return { data: null, diag: diagnostic(false, result.stderr || "memory probe failed") };
  }

  const lines = result.stdout.split("\n");
  const memLine = lines.find((line) => line.startsWith("Mem:"));
  const swapLine = lines.find((line) => line.startsWith("Swap:"));
  if (!memLine || !swapLine) {
    return { data: null, diag: diagnostic(false, "memory probe returned malformed output") };
  }

  const mem = memLine.trim().split(/\s+/);
  const swap = swapLine.trim().split(/\s+/);
  return {
    data: {
      mem: {
        total: Number(mem[1]),
        used: Number(mem[2]),
        free: Number(mem[3]),
        available: Number(mem[6] || mem[3]),
      },
      swap: {
        total: Number(swap[1]),
        used: Number(swap[2]),
      },
    },
    diag: diagnostic(true, "memory probe ok"),
  };
}

async function collectTopProcesses() {
  const result = await execBash("ps -eo pid,comm,%cpu,%mem,etime,args --sort=-%cpu | head -n 8");
  if (!result.ok || !result.stdout) {
    return { data: [], diag: diagnostic(false, result.stderr || "ps probe failed") };
  }

  const lines = result.stdout.split("\n").slice(1);
  const data = lines
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.+)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number(match[1]),
        command: match[2],
        cpu: Number(match[3]),
        mem: Number(match[4]),
        elapsed: match[5],
        args: match[6],
      };
    })
    .filter(Boolean)
    .filter((entry) => !["ps", "head", "sh", "bash", "ss"].includes(entry.command))
    .slice(0, 6);

  return { data, diag: diagnostic(true, "process probe ok") };
}

async function collectPorts() {
  const result = await execCommand("ss", ["-ltnpH"]);
  if (!result.ok) {
    return { data: [], diag: diagnostic(false, result.stderr || "ss probe failed") };
  }

  const lines = result.stdout ? result.stdout.split("\n").filter(Boolean) : [];
  const ports = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) {
      continue;
    }
    const localAddress = parts[3];
    const portText = localAddress.slice(localAddress.lastIndexOf(":") + 1);
    const port = Number(portText);
    if (!Number.isFinite(port)) {
      continue;
    }

    const processMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    const pid = processMatch ? Number(processMatch[2]) : null;
    let cwd = null;
    if (pid) {
      try {
        cwd = await readlink(`/proc/${pid}/cwd`);
      } catch {
        cwd = null;
      }
    }

    const entry = {
      address: localAddress,
      port,
      process: processMatch ? processMatch[1] : null,
      pid,
      cwd,
    };
    if (PORTS_TO_PROBE.has(port)) {
      entry.http = await httpHeadProbe(port);
    }
    ports.push(entry);
  }

  return {
    data: ports.sort((a, b) => a.port - b.port),
    diag: diagnostic(true, `ports probe ok (${ports.length} listeners)`),
  };
}

async function collectServices() {
  const result = await execCommand("systemctl", ["--user", "--no-pager", "--plain", "--type=service", "--state=running"]);
  if (!result.ok) {
    return { data: [], diag: diagnostic(false, result.stderr || "systemctl probe failed") };
  }

  const data = result.stdout
    .split("\n")
    .filter((line) => line && !line.startsWith("UNIT") && !line.startsWith("Legend:") && !line.includes("loaded units listed."))
    .map((line) => {
      const match = line.match(/^(\S+)\s+loaded\s+active\s+running\s+(.+)$/);
      return match ? { unit: match[1], description: match[2] } : null;
    })
    .filter(Boolean);

  return { data, diag: diagnostic(true, `service probe ok (${data.length} running)`) };
}

async function collectIngress() {
  const [caddyActive, nginxActive, caddyExists, nginxExists, caddyfileExists, nginxSitesEnabledExists, nginxConfDExists] = await Promise.all([
    execCommand("systemctl", ["is-active", "caddy"]),
    execCommand("systemctl", ["is-active", "nginx"]),
    execCommand("systemctl", ["is-enabled", "caddy"]),
    execCommand("systemctl", ["is-enabled", "nginx"]),
    exists(CADDYFILE_PATH),
    exists(NGINX_SITES_ENABLED),
    exists(NGINX_CONF_D),
  ]);

  let caddyfile = "";
  let caddyHosts = [];
  let caddyTargets = [];
  if (caddyfileExists) {
    try {
      caddyfile = await readFile(CADDYFILE_PATH, "utf8");
      caddyHosts = parseCaddyHosts(caddyfile);
      caddyTargets = [
        ...new Set(
          caddyfile
            .split("\n")
            .map((line) => portFromReverseProxyLine(line))
            .filter((value) => Number.isFinite(value))
        ),
      ];
    } catch {
      caddyfile = "";
    }
  }

  const nginxFiles = [
    ...(nginxSitesEnabledExists ? await readDirectoryFiles(NGINX_SITES_ENABLED) : []),
    ...(nginxConfDExists ? await readDirectoryFiles(NGINX_CONF_D) : []),
  ];
  const nginxHosts = [
    ...new Set(
      nginxFiles.flatMap((file) => parseNginxHosts(file.content))
    ),
  ];

  const caddyRunning = caddyActive.ok && caddyActive.stdout.trim() === "active";
  const nginxRunning = nginxActive.ok && nginxActive.stdout.trim() === "active";
  const caddyEnabled = caddyExists.ok && caddyExists.stdout.trim() === "enabled";
  const nginxEnabled = nginxExists.ok && nginxExists.stdout.trim() === "enabled";

  return {
    data: {
      caddy: {
        running: caddyRunning,
        enabled: caddyEnabled,
        configPresent: caddyfileExists,
        configPath: CADDYFILE_PATH,
        hosts: caddyHosts,
        targets: caddyTargets,
      },
      nginx: {
        running: nginxRunning,
        enabled: nginxEnabled,
        configPresent: nginxSitesEnabledExists || nginxConfDExists,
        configRoots: [NGINX_SITES_ENABLED, NGINX_CONF_D],
        hosts: nginxHosts,
      },
      hostnames: [...new Set([...caddyHosts, ...nginxHosts])].sort(),
      multiSubdomainReady: caddyHosts.length + nginxHosts.length >= 2,
    },
    diag: diagnostic(
      caddyfileExists || nginxSitesEnabledExists || nginxConfDExists,
      caddyfileExists || nginxSitesEnabledExists || nginxConfDExists ? "ingress probe ok" : "no caddy/nginx config discovered",
      {
        caddyRunning,
        nginxRunning,
      }
    ),
  };
}

async function collectTmux() {
  const panesResult = await execCommand("tmux", ["list-panes", "-a", "-F", "#S\t#I.#P\t#{pane_current_command}\t#{pane_current_path}"]);
  const windowsResult = await execCommand("tmux", ["list-windows", "-a"]);

  const recentLogs = [];
  try {
    const names = await readdir(TMUX_LOG_DIR);
    const stats = await Promise.all(
      names.map(async (name) => {
        const logPath = path.join(TMUX_LOG_DIR, name);
        const info = await stat(logPath);
        return { name, mtimeMs: info.mtimeMs, size: info.size };
      })
    );
    stats
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 5)
      .forEach((entry) => {
        recentLogs.push(`${entry.name} (${formatBytes(entry.size)})`);
      });
  } catch {
    // ignore
  }

  let utcWarnings = 0;
  try {
    const statusLog = await readFile(AGENTY_STATUS_LOG, "utf8");
    const matches = statusLog.match(/datetime\.utcnow/g);
    utcWarnings = matches ? matches.length : 0;
  } catch {
    utcWarnings = 0;
  }

  const panes = panesResult.ok && panesResult.stdout
    ? panesResult.stdout.split("\n").map((line) => {
        const [session, pane, command, currentPath] = line.split("\t");
        return { session, pane, command, currentPath };
      })
    : [];
  const windows = windowsResult.ok && windowsResult.stdout ? windowsResult.stdout.split("\n").filter(Boolean) : [];
  const ok = panesResult.ok && windowsResult.ok;

  return {
    data: { panes, windows, recentLogs, utcWarnings },
    diag: diagnostic(ok, ok ? `tmux probe ok (${panes.length} panes)` : panesResult.stderr || windowsResult.stderr),
  };
}

async function findRepos(root, maxDepth = 4) {
  const found = [];

  async function walk(current, depth) {
    if (found.length >= MAX_REPOS || depth > maxDepth) {
      return;
    }
    if (IGNORED_REPO_PREFIXES.some((prefix) => current.startsWith(prefix))) {
      return;
    }

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((entry) => entry.isDirectory() && entry.name === ".git")) {
      found.push(current);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
        continue;
      }
      await walk(path.join(current, entry.name), depth + 1);
      if (found.length >= MAX_REPOS) {
        return;
      }
    }
  }

  await walk(root, 1);
  return found.sort();
}

async function gitLine(repo, args) {
  const result = await execCommand("git", ["-C", repo, ...args], 8000, 2 * 1024 * 1024);
  return result.ok ? result.stdout.split("\n")[0]?.trim() || "" : "";
}

async function refreshRepoSnapshot() {
  const repos = await findRepos(GIT_SCAN_ROOT, 4);
  const data = [];
  const sampledAt = Date.now();

  for (const repo of repos.slice(0, MAX_REPOS)) {
    const [remote, branch, dirtyOutput, upstream] = await Promise.all([
      gitLine(repo, ["remote", "get-url", "origin"]),
      gitLine(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then(async (value) => value || (await gitLine(repo, ["rev-parse", "--short", "HEAD"]))),
      execBash(`git -C "${repo.replace(/"/g, '\\"')}" status --porcelain 2>/dev/null | wc -l`, 10000),
      gitLine(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    ]);

    data.push({
      repo,
      branch: branch || null,
      dirty: Number(dirtyOutput.stdout || "0"),
      upstream: upstream || null,
      remote: remote || null,
    });
  }

  state.repoSnapshot = data;
  state.lastRepoScanAt = sampledAt;
  return {
    data,
    diag: diagnostic(true, `repo scan ok (${data.length} repos)`),
    sampledAt,
  };
}

async function collectRepos() {
  if (!state.repoSnapshot || Date.now() - state.lastRepoScanAt > REPO_REFRESH_MS) {
    return refreshRepoSnapshot();
  }
  return {
    data: state.repoSnapshot,
    diag: diagnostic(true, "repo scan reused from cache", { cached: true }),
    sampledAt: state.lastRepoScanAt,
  };
}

function runbook(title, commands) {
  return { title, commands };
}

function normalizeItem(item, collectedAt) {
  const allowedConfidence = new Set(["measured", "derived", "inferred", "unknown"]);
  const normalizeCheckedAt = (value) => {
    if (!value) {
      return collectedAt;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return collectedAt;
    }
    return date.toISOString();
  };

  if (typeof item === "string") {
    return inferredItem(item, "unspecified", collectedAt);
  }
  if (!item || typeof item !== "object") {
    return unknownItem("invalid item", "unspecified", collectedAt);
  }

  return {
    text: item.text ?? "missing text",
    source: item.source ?? "unspecified",
    checkedAt: normalizeCheckedAt(item.checkedAt),
    confidence: allowedConfidence.has(item.confidence) ? item.confidence : "inferred",
    ok: item.ok !== false,
    detail: item.detail ?? null,
  };
}

function normalizeSections(sections, collectedAt) {
  return sections.map((section) => ({
    ...section,
    groups: (section.groups || []).map((group) => ({
      ...group,
      items: (group.items || []).map((item) => normalizeItem(item, collectedAt)),
    })),
  }));
}

function validateSnapshot(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== "object") {
    return { ok: false, errors: ["snapshot is not an object"] };
  }
  if (!snapshot.collectedAt || Number.isNaN(Date.parse(snapshot.collectedAt))) {
    errors.push("collectedAt missing or invalid");
  }
  if (!Array.isArray(snapshot.sections)) {
    errors.push("sections missing or not an array");
  } else {
    snapshot.sections.forEach((section, index) => {
      if (!section || typeof section !== "object") {
        errors.push(`section[${index}] is not an object`);
        return;
      }
      if (!section.id) {
        errors.push(`section[${index}] missing id`);
      }
      if (!Array.isArray(section.groups)) {
        errors.push(`section[${index}] groups missing or not an array`);
        return;
      }
      section.groups.forEach((group, groupIndex) => {
        if (!group || typeof group !== "object") {
          errors.push(`section[${index}].groups[${groupIndex}] is not an object`);
          return;
        }
        if (!Array.isArray(group.items)) {
          errors.push(`section[${index}].groups[${groupIndex}].items missing or not an array`);
          return;
        }
        group.items.forEach((item, itemIndex) => {
          if (!item || typeof item !== "object") {
            errors.push(`section[${index}].groups[${groupIndex}].items[${itemIndex}] is not an object`);
            return;
          }
          if (!item.text) {
            errors.push(`section[${index}].groups[${groupIndex}].items[${itemIndex}] missing text`);
          }
        });
      });
    });
  }
  return { ok: errors.length === 0, errors };
}

function makeItem(text, source, checkedAt, options = {}) {
  return {
    text,
    source,
    checkedAt,
    confidence: options.confidence || "measured",
    ok: options.ok !== false,
    detail: options.detail || null,
  };
}

function measuredItem(text, source, checkedAt, detail) {
  return makeItem(text, source, checkedAt, { confidence: "measured", detail });
}

function derivedItem(text, source, checkedAt, detail) {
  return makeItem(text, source, checkedAt, { confidence: "derived", detail });
}

function inferredItem(text, source, checkedAt, detail) {
  return makeItem(text, source, checkedAt, { confidence: "inferred", detail });
}

function unknownItem(text, source, checkedAt, detail) {
  return makeItem(text, source, checkedAt, { confidence: "unknown", ok: false, detail });
}

function summarizePath(filePath) {
  if (!filePath) {
    return "unknown";
  }
  return filePath.startsWith(HOME_ROOT) ? `~${filePath.slice(HOME_ROOT.length)}` : filePath;
}

function normalizeHostname(value) {
  return value
    .replace(/^https?:\/\//, "")
    .replace(/\{.*?\}/g, "")
    .replace(/[:{].*$/, "")
    .replace(/[{},]/g, "")
    .trim();
}

function parseCaddyHosts(content) {
  const hosts = [];
  const lines = content.split("\n");
  const ignoredTokens = new Set([
    "try_files",
    "header",
    "handle",
    "route",
    "root",
    "redir",
    "respond",
    "file_server",
    "reverse_proxy",
    "encode",
    "tls",
    "import",
    "basicauth",
    "log",
  ]);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("{") || line.startsWith("}") || line.startsWith("(")) {
      continue;
    }
    if (line.includes("{")) {
      const candidate = line.slice(0, line.indexOf("{")).trim();
      if (!candidate || candidate.includes(" ")) {
        continue;
      }
      const entries = candidate
        .split(",")
        .map(normalizeHostname)
        .filter(Boolean)
        .filter((value) => value !== "http://")
        .filter((value) => !ignoredTokens.has(value))
        .filter((value) => value.includes("."));
      hosts.push(...entries);
    }
  }

  return [...new Set(hosts)];
}

function parseNginxHosts(content) {
  const matches = [...content.matchAll(/server_name\s+([^;]+);/g)];
  return [
    ...new Set(
      matches
        .flatMap((match) => match[1].split(/\s+/))
        .map(normalizeHostname)
        .filter(Boolean)
    ),
  ];
}

function portFromReverseProxyLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("reverse_proxy ")) {
    return null;
  }

  const token = trimmed.split(/\s+/)[1];
  if (!token || token.startsWith("{")) {
    return null;
  }

  if (/^\d{2,5}$/.test(token)) {
    return Number(token);
  }

  const withoutScheme = token.replace(/^https?:\/\//, "");
  const match = withoutScheme.match(/:(\d{2,5})(?:\/|$)/);
  return match ? Number(match[1]) : null;
}

async function readDirectoryFiles(dirPath) {
  try {
    const names = await readdir(dirPath);
    const results = await Promise.all(
      names.map(async (name) => {
        const filePath = path.join(dirPath, name);
        try {
          const content = await readFile(filePath, "utf8");
          return { name, filePath, content };
        } catch {
          return null;
        }
      })
    );
    return results.filter(Boolean);
  } catch {
    return [];
  }
}

async function probeTmuxdeskIntegration(collectedAt) {
  const root = SIBLING_PATHS.tmuxdesk;
  if (!(await exists(root))) {
    return {
      id: "tmuxdesk",
      label: "tmuxdesk",
      status: "ABSENT",
      statusColor: "#6A5A40",
      attention: 0,
      objective: "tmux fleet sibling project not present on this host.",
      groups: [{ heading: "A. Status", items: [unknownItem("tmuxdesk repo not found", "fs.access()", collectedAt)] }],
      subrubrics: [],
    };
  }

  let nodeCount = 0;
  let fleetNodes = [];
  try {
    const fleetConf = await readFile(path.join(root, "fleet.conf"), "utf8");
    fleetNodes = fleetConf
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split(/\s+/))
      .filter((parts) => parts.length >= 4)
      .map((parts) => ({ name: parts[0], alias: parts[1], sigil: parts[2], ip: parts[3] }));
    nodeCount = fleetNodes.length;
  } catch {
    nodeCount = 0;
  }

  const stateDir = path.join(root, "state");
  let repoStateFiles = [];
  try {
    repoStateFiles = (await readdir(stateDir)).filter((name) => name !== ".gitkeep");
  } catch {
    repoStateFiles = [];
  }

  const [branch, dirtyOut] = await Promise.all([
    gitLine(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then(async (value) => value || (await gitLine(root, ["rev-parse", "--short", "HEAD"]))),
    execBash(`git -C "${root}" status --porcelain 2>/dev/null | wc -l`, 10000),
  ]);
  const dirty = Number(dirtyOut.stdout || "0");
  const attention = clamp((dirty > 0 ? 0.25 : 0) + (repoStateFiles.length === 0 ? 0.15 : 0));

  return {
    id: "tmuxdesk",
    label: "tmuxdesk",
    status: dirty > 0 ? "DIRTY" : "READY",
    statusColor: dirty > 0 ? "#FF9500" : "#34C759",
    attention,
    objective: "Tmux fleet sibling adapter: fleet topology, repo drift, and available state artifacts.",
    groups: [
      {
        heading: "A. Fleet topology",
        items: [
          measuredItem(`Configured fleet nodes: ${nodeCount}`, "readFile(fleet.conf)", collectedAt),
          ...fleetNodes.slice(0, 5).map((node) => measuredItem(`${node.name} ${node.sigil} ${node.ip}`, "readFile(fleet.conf)", collectedAt)),
        ],
      },
      {
        heading: "B. Local integration surface",
        items: [
          measuredItem(`Repo branch: ${branch || "unknown"}`, "git symbolic-ref/rev-parse", collectedAt),
          measuredItem(`Dirty files: ${dirty}`, "git status --porcelain", collectedAt),
          measuredItem(`Repo state files present: ${repoStateFiles.length}`, "readdir(state/)", collectedAt),
          derivedItem("Observation surface already consumes live tmux panes from this host", "collectTmux()", collectedAt),
        ],
      },
    ],
    subrubrics: [
      runbook("tmuxdesk Fleet Health", [
        `${root}/bin/fleet-health.sh`,
        `sed -n '1,120p' ${root}/fleet.conf`,
      ]),
      runbook("tmuxdesk Repo Audit", [
        `git -C ${root} status --short`,
        `git -C ${root} diff --stat`,
      ]),
    ],
  };
}

async function probeCorporaInterfacesIntegration(collectedAt) {
  const root = SIBLING_PATHS.corporaInterfaces;
  if (!(await exists(root))) {
    return {
      id: "corpora",
      label: "corpora-interfaces",
      status: "ABSENT",
      statusColor: "#6A5A40",
      attention: 0,
      objective: "Corpora sibling project not present on this host.",
      groups: [{ heading: "A. Status", items: [unknownItem("corpora-interfaces project not found", "fs.access()", collectedAt)] }],
      subrubrics: [],
    };
  }

  let packageJson = null;
  try {
    packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  } catch {
    packageJson = null;
  }

  let appStat = null;
  try {
    appStat = await stat(path.join(root, "src", "App.jsx"));
  } catch {
    appStat = null;
  }

  const hasNodeModules = await exists(path.join(root, "node_modules"));
  const hasSrcApp = await exists(path.join(root, "src", "App.jsx"));
  const attention = clamp((hasNodeModules ? 0 : 0.15) + (hasSrcApp ? 0 : 0.25));

  return {
    id: "corpora",
    label: "corpora-interfaces",
    status: hasSrcApp ? "READY" : "THIN",
    statusColor: hasSrcApp ? "#30D5C8" : "#FF9500",
    attention,
    objective: "Corpora sibling adapter: inspect local package surface so it can become a first-class upstream for future observation data.",
    groups: [
      {
        heading: "A. Package surface",
        items: [
          measuredItem(`Package: ${packageJson?.name || "unknown"}`, "readFile(package.json)", collectedAt),
          measuredItem(
            `Scripts: ${packageJson?.scripts ? Object.keys(packageJson.scripts).join(", ") : "none discovered"}`,
            "readFile(package.json)",
            collectedAt
          ),
          measuredItem(`node_modules present: ${hasNodeModules ? "yes" : "no"}`, "fs.access(node_modules)", collectedAt),
        ],
      },
      {
        heading: "B. Integration posture",
        items: [
          measuredItem(`App entry present: ${hasSrcApp ? "yes" : "no"}`, "fs.access(src/App.jsx)", collectedAt),
          measuredItem(`src/App.jsx mtime: ${appStat ? new Date(appStat.mtimeMs).toISOString() : "unknown"}`, "stat(src/App.jsx)", collectedAt),
          derivedItem("No runtime endpoint detected yet; current integration is filesystem/package-level", "design rule", collectedAt),
        ],
      },
    ],
    subrubrics: [
      runbook("corpora-interfaces Boot", [
        `cd ${root}`,
        "npm install",
        "npm run dev -- --host 0.0.0.0",
      ]),
      runbook("corpora-interfaces Shape Audit", [
        `find ${root} -maxdepth 2 -type f | sort | head -n 80`,
        `sed -n '1,120p' ${root}/package.json`,
      ]),
    ],
  };
}

async function collectSiblingIntegrations(collectedAt) {
  const adapters = await Promise.all([probeTmuxdeskIntegration(collectedAt), probeCorporaInterfacesIntegration(collectedAt)]);
  return {
    data: adapters,
    diag: diagnostic(true, `sibling adapter probe ok (${adapters.length} adapters)`),
  };
}

function summarizePorts(ports, collectedAt) {
  const publicPorts = ports.filter((entry) => ![22, 53, 2019, 4369].includes(entry.port));
  const httpPorts = publicPorts.filter((entry) => entry.http || PORTS_TO_PROBE.has(entry.port));
  const failedProbes = httpPorts.filter((entry) => entry.http && !entry.http.ok);
  const unmanaged = publicPorts.filter((entry) => entry.process && !["caddy"].includes(entry.process));
  const attention = clamp(failedProbes.length * 0.35 + unmanaged.length * 0.05);

  return {
    status: failedProbes.length ? "DEGRADED" : "LIVE",
    statusColor: failedProbes.length ? "#FF9500" : "#30D5C8",
    attention,
    objective: "Listening sockets and HTTP probes from the current host snapshot.",
    groups: [
      {
        heading: "A. HTTP listeners",
        items: httpPorts.length
          ? httpPorts
              .map((entry) => {
                const headline = entry.http?.headline ? `, ${entry.http.headline}` : "";
                const detail = entry.http ? `${entry.http.headline}${Number.isFinite(entry.http.latencyMs) ? ` · ${entry.http.latencyMs}ms` : ""}` : null;
                const text = `${entry.port} -> ${entry.process || "unknown"}${entry.cwd ? ` @ ${entry.cwd}` : ""}${headline}`;
                return measuredItem(text, "ss -ltnpH", collectedAt, detail);
              })
              .slice(0, 10)
          : [measuredItem("No HTTP listeners observed", "ss -ltnpH", collectedAt)],
      },
      {
        heading: "B. Probe health",
        items: failedProbes.length
          ? failedProbes.map((entry) =>
              makeItem(`${entry.port} probe failed`, "httpHeadProbe()", collectedAt, {
                ok: false,
                confidence: "measured",
                detail: entry.http ? `${entry.http.headline}${Number.isFinite(entry.http.latencyMs) ? ` · ${entry.http.latencyMs}ms` : ""}` : null,
              })
            )
          : [measuredItem("All probed HTTP listeners responded on loopback", "httpHeadProbe()", collectedAt)],
      },
    ],
    subrubrics: [
      runbook("Loopback Checks", [
        "curl -sS -I http://127.0.0.1:8091/api/state",
        "ss -ltnp | rg ':(80|443|7391|8090|8091|8751|8901|17888|31823)'",
      ]),
      runbook("Port Ownership", [
        "ss -ltnp",
        "readlink -f /proc/<pid>/cwd",
      ]),
    ],
  };
}

function summarizeIngress(ingress, ports, collectedAt) {
  const caddyHosts = ingress.caddy?.hosts || [];
  const nginxHosts = ingress.nginx?.hosts || [];
  const caddyTargets = ingress.caddy?.targets || [];
  const localPorts = new Set(ports.map((entry) => entry.port));
  const missingTargets = caddyTargets.filter((port) => !localPorts.has(port));
  const activeProxyCount = Number(Boolean(ingress.caddy?.running)) + Number(Boolean(ingress.nginx?.running));
  const attention = clamp(
    (missingTargets.length ? 0.45 : 0) +
      (activeProxyCount > 1 ? 0.15 : 0) +
      (!ingress.caddy?.running && !ingress.nginx?.running ? 0.35 : 0)
  );
  const status = missingTargets.length ? "MISWIRED" : activeProxyCount ? "ROUTED" : "THIN";
  const statusColor = missingTargets.length ? "#FF3B30" : activeProxyCount ? "#30D5C8" : "#FF9500";

  return {
    status,
    statusColor,
    attention,
    objective: "Ingress truth: which proxy is actually active, which hostnames are configured, and whether reverse-proxy targets land on live listeners.",
    groups: [
      {
        heading: "A. Proxy daemons",
        items: [
          measuredItem(
            `Caddy: ${ingress.caddy?.running ? "running" : ingress.caddy?.enabled ? "enabled but inactive" : "inactive"}${ingress.caddy?.configPresent ? ` @ ${ingress.caddy.configPath}` : ""}`,
            "systemctl is-active/is-enabled caddy",
            collectedAt
          ),
          measuredItem(
            `nginx: ${ingress.nginx?.running ? "running" : ingress.nginx?.enabled ? "enabled but inactive" : "inactive"}${ingress.nginx?.configPresent ? " with config present" : ""}`,
            "systemctl is-active/is-enabled nginx",
            collectedAt
          ),
        ],
      },
      {
        heading: "B. Hostname and route surface",
        items: [
          ...(caddyHosts.length
            ? caddyHosts.slice(0, 8).map((host) => measuredItem(`Caddy host: ${host}`, "parseCaddyHosts(Caddyfile)", collectedAt))
            : [measuredItem("No Caddy hostnames discovered", "parseCaddyHosts(Caddyfile)", collectedAt)]),
          ...(nginxHosts.length
            ? nginxHosts.slice(0, 6).map((host) => measuredItem(`nginx host: ${host}`, "parseNginxHosts(config)", collectedAt))
            : [measuredItem("No nginx hostnames discovered", "parseNginxHosts(config)", collectedAt)]),
          ...(caddyTargets.length
            ? caddyTargets.map((port) =>
                measuredItem(
                  `reverse_proxy -> localhost:${port}${localPorts.has(port) ? " ok" : " missing listener"}`,
                  "portFromReverseProxyLine(Caddyfile)",
                  collectedAt,
                  localPorts.has(port) ? null : "no matching local listener"
                )
              )
            : [measuredItem("No reverse_proxy targets parsed from Caddy", "portFromReverseProxyLine(Caddyfile)", collectedAt)]),
        ].slice(0, 12),
      },
    ],
    subrubrics: [
      runbook("Ingress Truth", [
        "systemctl is-active caddy nginx",
        `sed -n '1,220p' ${CADDYFILE_PATH}`,
        `ss -ltnp | rg ':(80|443|8091|8090|7391|8751|8901|17888|31823)'`,
      ]),
      runbook("Virtual Host Audit", [`ls -la ${NGINX_SITES_ENABLED}`, `ls -la ${NGINX_CONF_D}`]),
    ],
  };
}

function summarizeHost(host, topProcesses, collectedAt) {
  const memoryRatio = 1 - host.mem.available / host.mem.total;
  const pressure = clamp(memoryRatio * 0.45 + host.load[0] / 4 * 0.35 + host.disk.usePct * 0.2);
  const status = pressure > 0.8 ? "HOT" : pressure > 0.55 ? "WARM" : "STABLE";
  const color = pressure > 0.8 ? "#FF3B30" : pressure > 0.55 ? "#FF9500" : "#34C759";

  return {
    status,
    statusColor: color,
    attention: pressure,
    objective: "Resource pressure from kernel uptime, load averages, memory, disk, and top CPU processes.",
    groups: [
      {
        heading: "A. Capacity",
        items: [
          measuredItem(`Uptime: ${formatDuration(host.uptimeSeconds)}`, host.sources.uptime, collectedAt),
          measuredItem(`Load average: ${host.load.map((v) => v.toFixed(2)).join(" / ")}`, host.sources.load, collectedAt),
          makeItem(
            `Memory: ${formatBytes(host.mem.used)} used / ${formatBytes(host.mem.total)} total, ${formatBytes(host.mem.available)} available`,
            host.sources.memory,
            collectedAt,
            { confidence: host.confidence.memory }
          ),
          makeItem(
            `Swap: ${formatBytes(host.swap.used)} used / ${formatBytes(host.swap.total)} total`,
            host.sources.swap,
            collectedAt,
            { confidence: host.confidence.swap, ok: host.confidence.swap !== "unknown" }
          ),
          makeItem(
            `Disk /: ${formatBytes(host.disk.used)} used / ${formatBytes(host.disk.total)} total (${Math.round(host.disk.usePct * 100)}%)`,
            host.sources.disk,
            collectedAt,
            { confidence: host.confidence.disk, ok: host.confidence.disk !== "unknown" }
          ),
        ],
      },
      {
        heading: "B. Top processes",
        items: topProcesses.length
          ? topProcesses
              .slice(0, 4)
              .map((proc) =>
                measuredItem(
                  `${proc.command} pid=${proc.pid} cpu=${proc.cpu}% mem=${proc.mem}% elapsed=${proc.elapsed}`,
                  host.sources.topProcesses,
                  collectedAt,
                  proc.args
                )
              )
          : [makeItem("No process sample available", host.sources.topProcesses, collectedAt, { confidence: "unknown", ok: false })],
      },
    ],
    subrubrics: [
      runbook("Host Pressure Checks", [
        "uptime",
        "free -h",
        "df -h /",
        "ps -eo pid,comm,%cpu,%mem,etime,args --sort=-%cpu | head -n 12",
      ]),
    ],
  };
}

function summarizeServices(services, ports, collectedAt) {
  const detached = ports.filter((entry) => entry.pid && entry.cwd && ![22, 53, 80, 443, 2019, 4369].includes(entry.port));
  const attention = clamp(detached.length * 0.08 + Math.max(0, detached.length - services.length) * 0.06);

  return {
    status: services.length ? "OBSERVED" : "THIN",
    statusColor: services.length ? "#FFD60A" : "#FF9500",
    attention,
    objective: "Managed user services plus detached listeners that are not supervised by systemd --user.",
    groups: [
      {
        heading: "A. Running user services",
        items: services.length
          ? services.map((entry) => measuredItem(`${entry.unit} -> ${entry.description}`, "systemctl --user --type=service --state=running", collectedAt))
          : [measuredItem("No running user services observed", "systemctl --user --type=service --state=running", collectedAt)],
      },
      {
        heading: "B. Detached listeners",
        items: detached
          .slice(0, 6)
          .map((entry) => derivedItem(`${entry.port} -> ${entry.process || "unknown"} @ ${entry.cwd || "cwd unknown"}`, "ss -ltnpH", collectedAt)),
      },
    ],
    subrubrics: [
      runbook("Service Health", [
        "systemctl --user --no-pager --plain --type=service --state=running",
        "systemctl --user status <unit> --no-pager -l",
      ]),
    ],
  };
}

function summarizeTmux(tmux, collectedAt) {
  const activePanes = tmux.panes.filter((pane) => pane.command !== "bash");
  const attention = clamp(activePanes.length * 0.08 + (tmux.utcWarnings > 0 ? 0.35 : 0));
  return {
    status: "ACTIVE",
    statusColor: "#AF52DE",
    attention,
    objective: "Current tmux panes plus the quality of nearby status/log surfaces.",
    groups: [
      {
        heading: "A. Active panes",
        items: activePanes.length
          ? activePanes
              .slice(0, 8)
              .map((pane) =>
                measuredItem(`${pane.session}:${pane.pane} ${pane.command} @ ${pane.currentPath}`, "tmux list-panes -a", collectedAt)
              )
          : [measuredItem("No non-bash panes observed", "tmux list-panes -a", collectedAt)],
      },
      {
        heading: "B. Observation hazards",
        items: [
          measuredItem(`agenty status log datetime.utcnow warnings: ${tmux.utcWarnings}`, `rg 'datetime.utcnow' ${AGENTY_STATUS_LOG}`, collectedAt),
          ...(tmux.recentLogs.length
            ? tmux.recentLogs.map((entry) => measuredItem(`recent log: ${entry}`, `ls -lt ${TMUX_LOG_DIR}`, collectedAt))
            : [measuredItem("No tmux logs found", `ls -lt ${TMUX_LOG_DIR}`, collectedAt)]),
        ].slice(0, 6),
      },
    ],
    subrubrics: [
      runbook("Pane Census", [
        "tmux list-panes -a -F '#S:#I.#P #{pane_current_command} #{pane_current_path}'",
        "tmux list-windows -a",
      ]),
      runbook("Log Spot Check", [
        `ls -lt ${TMUX_LOG_DIR} | head -n 10`,
        `tail -n 40 ${AGENTY_STATUS_LOG}`,
      ]),
    ],
  };
}

function summarizeRepos(repos, collectedAt, reposSampledAt) {
  const checkedAt = reposSampledAt ? new Date(reposSampledAt).toISOString() : collectedAt;
  const withOrigin = repos.filter((repo) => repo.remote);
  const cleanTracked = withOrigin.filter((repo) => repo.dirty === 0 && repo.upstream);
  const dirty = withOrigin.filter((repo) => repo.dirty > 0).sort((a, b) => b.dirty - a.dirty);
  const attention = clamp((dirty.length / Math.max(1, withOrigin.length)) * 0.8 + (dirty[0]?.dirty || 0) / 1000);
  return {
    status: dirty.length ? "MIXED" : "CLEAN",
    statusColor: dirty.length ? "#FF9500" : "#34C759",
    attention,
    objective: "Git worktree drift across the workspace, separated into safe fast-forward candidates and repos requiring manual integration.",
    groups: [
      {
        heading: "A. Clean tracked repos",
        items: cleanTracked.length
          ? cleanTracked
              .slice(0, 10)
              .map((repo) => measuredItem(`${repo.repo} [${repo.branch}] tracking ${repo.upstream}`, "git status/branch/upstream", checkedAt))
          : [measuredItem("No clean tracked repos found", "git status/branch/upstream", checkedAt)],
      },
      {
        heading: "B. Dirty repos needing care",
        items: dirty.length
          ? dirty
              .slice(0, 10)
              .map((repo) =>
                measuredItem(
                  `${repo.repo} [${repo.branch}] dirty=${repo.dirty}${repo.upstream ? ` upstream=${repo.upstream}` : " upstream=none"}`,
                  "git status --porcelain",
                  checkedAt
                )
              )
          : [measuredItem("No dirty repos with origin remotes", "git status --porcelain", checkedAt)],
      },
    ],
    subrubrics: [
      runbook("Safe Pull Workflow", [
        "git -C <repo> fetch --all --prune --tags",
        "git -C <repo> status --short",
        "git -C <repo> pull --ff-only",
      ]),
      runbook("Dirty Tree Audit", [
        "git -C <repo> status --short",
        "git -C <repo> rev-parse --abbrev-ref --symbolic-full-name @{u}",
        "git -C <repo> diff --stat",
      ]),
    ],
    counts: {
      total: repos.length,
      withOrigin: withOrigin.length,
      cleanTracked: cleanTracked.length,
      dirty: dirty.length,
    },
  };
}

function summarizeVerdict(hostSection, portsSection, servicesSection, tmuxSection, reposSection, diagnostics, collectedAt) {
  const failedSources = Object.values(diagnostics).filter((entry) => !entry.ok).length;
  const stalenessMs = Date.now() - Date.parse(collectedAt);
  const stale = stalenessMs > STALE_AFTER_MS;
  const attention = clamp((hostSection.attention + portsSection.attention + servicesSection.attention + tmuxSection.attention + reposSection.attention) / 5 + (stale ? 0.2 : 0));
  const status = failedSources || stale ? "DEGRADED" : "ACTIONABLE";
  const statusColor = failedSources || stale ? "#FF3B30" : "#FF2D92";

  return {
    status,
    statusColor,
    attention,
    objective: "This report is only trustworthy if collection, validation, rendering freshness, and source probes all remain explicit.",
    groups: [
      {
        heading: "A. Current state",
        items: [
          measuredItem(`Collector freshness: ${state.collector.lastCollectedAt || "never"}`, "collectorStatusSummary()", collectedAt),
          measuredItem(`Snapshot staleness: ${stalenessMs} ms`, "collectorStatusSummary()", collectedAt),
          measuredItem(`Source probes failing: ${failedSources}`, "diagnostics", collectedAt),
          derivedItem(`Host pressure index: ${Math.round(hostSection.attention * 100)}%`, "summarizeHost()", collectedAt),
          derivedItem(`Repo drift index: ${Math.round(reposSection.attention * 100)}%`, "summarizeRepos()", collectedAt),
        ],
      },
      {
        heading: "B. Priorities",
        items: [
          derivedItem(stale ? "Collector freshness breached stale threshold" : "Collector freshness is within threshold", "collectorStatusSummary()", collectedAt),
          derivedItem(failedSources ? "Repair failed probes before trusting the report" : "Observation chain is healthy", "diagnostics", collectedAt),
          derivedItem(reposSection.counts?.dirty ? "Dirty repos still block safe bulk pulls" : "Repo layer is currently quiet", "summarizeRepos()", collectedAt),
          derivedItem(tmuxSection.attention > 0.3 ? "Status/log noise still pollutes observation quality" : "Interactive surfaces are readable", "summarizeTmux()", collectedAt),
        ],
      },
    ],
    subrubrics: [
      runbook("Observation Surface Verification", [
        "curl -sS http://127.0.0.1:8091/api/state | jq '.collector,.diagnostics,.sections[] | select(.id==\"verdict\")'",
        "curl -sS -I http://127.0.0.1:8091/",
      ]),
      runbook("Collector Logs", [
        "ps -ef | rg 'node server.mjs'",
        "ss -ltnp | rg 8091",
      ]),
    ],
  };
}

function deriveDeployment(ingress, ports, repos) {
  const caddyHosts = ingress.caddy?.hosts || [];
  const nginxHosts = ingress.nginx?.hosts || [];
  const caddyTargets = ingress.caddy?.targets || [];
  const port8091 = ports.find((entry) => entry.port === 8091);
  const publicObservationHost = caddyHosts.find((host) => /observe|state|report/i.test(host)) || caddyHosts[0] || nginxHosts[0] || null;
  const publicUrl = publicObservationHost ? `https://${publicObservationHost}` : port8091 ? "http://localhost:8091" : null;
  const serverStateReportServed = Boolean(publicObservationHost || port8091?.http?.ok);
  const bothRunning = Boolean(ingress.caddy?.running && ingress.nginx?.running);
  const proxyOk = ingress.caddy?.running ? !ingress.nginx?.running || nginxHosts.length > 0 : Boolean(ingress.nginx?.running);
  const subdomainCount = new Set([...caddyHosts, ...nginxHosts]).size;
  const dirtyCount = repos.filter((repo) => repo.dirty > 0).length;

  return {
    publicUrl,
    serverStateReportOk: serverStateReportServed,
    serverStateReportSection: publicObservationHost ? "ingress" : "ports",
    serverStateReportAnswer: serverStateReportServed ? "yes, this host exposes it" : "not publicly confirmed",
    serverStateReportDetail: serverStateReportServed
      ? publicObservationHost
        ? `Observed hostname ${publicObservationHost}${caddyTargets.includes(8091) ? " -> reverse_proxy localhost:8091" : ""}`
        : `Loopback listener present on localhost:8091${port8091?.http?.ok ? ` (${port8091.http.headline})` : ""}`
      : "No hostname route or loopback HTTP listener to the observation surface was observed.",
    proxyOk,
    proxyAnswer: bothRunning
      ? "both proxies are live; verify they are intentionally split"
      : ingress.caddy?.running
        ? "caddy is the active ingress"
        : ingress.nginx?.running
          ? "nginx is the active ingress"
          : "no active ingress daemon observed",
    proxyDetail: bothRunning
      ? `Caddy hosts: ${caddyHosts.length}, nginx hosts: ${nginxHosts.length}`
      : ingress.caddy?.running
        ? `Caddy config present with ${caddyHosts.length} hostnames and ${caddyTargets.length} reverse_proxy targets`
        : ingress.nginx?.running
          ? `nginx config present with ${nginxHosts.length} hostnames`
          : "Neither Caddy nor nginx was observed running.",
    subdomainOk: subdomainCount >= 2 && (ingress.caddy?.running || ingress.nginx?.running),
    subdomainAnswer: subdomainCount >= 2 ? `${subdomainCount} hostnames discovered` : subdomainCount === 1 ? "single hostname configured" : "no hostname inventory yet",
    subdomainDetail:
      subdomainCount >= 2
        ? `${dirtyCount} dirty repos on host; deployment capacity exists, but app hygiene still matters`
        : "Add more hostname routes in Caddy/nginx before claiming multi-subdomain readiness.",
  };
}

function summarizeSiblings(adapters, collectedAt) {
  const attention = clamp(adapters.reduce((sum, adapter) => sum + adapter.attention, 0) / Math.max(1, adapters.length));
  const readyCount = adapters.filter((adapter) => adapter.status !== "ABSENT").length;
  const degradedCount = adapters.filter((adapter) => ["DIRTY", "THIN"].includes(adapter.status)).length;

  return {
    status: degradedCount ? "MIXED" : readyCount ? "HOOKED" : "ABSENT",
    statusColor: degradedCount ? "#FF9500" : readyCount ? "#30D5C8" : "#6A5A40",
    attention,
    objective: "Sibling project adapters let the observation surface project adjacent systems without hard-coding them into the core collector.",
    groups: [
      {
        heading: "A. Adapter inventory",
        items: adapters.length
          ? adapters.map((adapter) => measuredItem(`${adapter.label} -> ${adapter.status}`, "collectSiblingIntegrations()", collectedAt))
          : [measuredItem("No sibling adapters discovered", "collectSiblingIntegrations()", collectedAt)],
      },
      {
        heading: "B. Architectural posture",
        items: [
          derivedItem("Sibling probes are isolated adapters, not embedded in the host core", "design rule", collectedAt),
          derivedItem("Each adapter can grow into its own runtime endpoint later", "design rule", collectedAt),
          derivedItem("This keeps the collector closer to an entity/event hub than a pile of bespoke panels", "design rule", collectedAt),
        ],
      },
    ],
    subrubrics: adapters.flatMap((adapter) =>
      adapter.subrubrics.map((item) => ({
        title: `${adapter.label} · ${item.title}`,
        commands: item.commands,
      }))
    ),
    adapters,
  };
}

function deriveEntityStore(snapshot) {
  const entities = {
    host: [],
    port: [],
    service: [],
    pane: [],
    repo: [],
    adapter: [],
    fleetNode: [],
  };
  const relations = [];

  entities.host.push({
    id: `host:${snapshot.host.hostname}`,
    hostname: snapshot.host.hostname,
    load1: snapshot.host.load[0],
    load5: snapshot.host.load[1],
    load15: snapshot.host.load[2],
  });

  for (const entry of snapshot.ports) {
    const id = `port:${entry.port}`;
    entities.port.push({
      id,
      port: entry.port,
      process: entry.process,
      pid: entry.pid,
      cwd: entry.cwd,
      httpOk: entry.http?.ok ?? null,
    });
    relations.push({ from: `host:${snapshot.host.hostname}`, to: id, type: "LISTENS_ON" });
  }

  for (const entry of snapshot.services) {
    const id = `service:${entry.unit}`;
    entities.service.push({ id, unit: entry.unit, description: entry.description });
    relations.push({ from: `host:${snapshot.host.hostname}`, to: id, type: "RUNS" });
  }

  for (const pane of snapshot.tmux.panes) {
    const id = `pane:${pane.session}:${pane.pane}`;
    entities.pane.push({ id, session: pane.session, pane: pane.pane, command: pane.command, currentPath: pane.currentPath });
    relations.push({ from: `host:${snapshot.host.hostname}`, to: id, type: "HAS_PANE" });
  }

  for (const repo of snapshot.repos) {
    const id = `repo:${repo.repo}`;
    entities.repo.push({ id, repo: repo.repo, branch: repo.branch, dirty: repo.dirty, upstream: repo.upstream, remote: repo.remote });
    relations.push({ from: `host:${snapshot.host.hostname}`, to: id, type: "HAS_REPO" });
  }

  for (const adapter of snapshot.siblings) {
    const adapterId = `adapter:${adapter.id}`;
    entities.adapter.push({ id: adapterId, name: adapter.label, status: adapter.status, attention: adapter.attention });
    relations.push({ from: `host:${snapshot.host.hostname}`, to: adapterId, type: "INTEGRATES" });

    if (adapter.id === "tmuxdesk") {
      const topologyGroup = adapter.groups.find((group) => group.heading === "A. Fleet topology");
      for (const item of topologyGroup?.items?.slice(1) || []) {
        const itemText = typeof item === "string" ? item : item.text;
        const parts = itemText.split(" ");
        const name = parts[0];
        const ip = parts[2];
        const nodeId = `fleetNode:${name}`;
        entities.fleetNode.push({ id: nodeId, name, ip });
        relations.push({ from: adapterId, to: nodeId, type: "TRACKS_NODE" });
      }
    }
  }

  const indexes = {
    counts: Object.fromEntries(Object.entries(entities).map(([key, value]) => [key, value.length])),
    hotRepos: entities.repo.filter((repo) => repo.dirty > 0).sort((a, b) => b.dirty - a.dirty).slice(0, 5).map((repo) => repo.id),
    httpPorts: entities.port.filter((port) => port.httpOk !== null).map((port) => port.id),
    activePanes: entities.pane.filter((pane) => pane.command !== "bash").map((pane) => pane.id),
  };

  return { entities, relations, indexes };
}

function summarizeEntityModel(entityStore, collectedAt) {
  const counts = entityStore.indexes.counts;
  const attention = clamp((counts.repo > 0 ? counts.repo / 100 : 0) + (counts.pane > 0 ? counts.pane / 100 : 0));
  return {
    status: "NORMALIZED",
    statusColor: "#30D5C8",
    attention,
    objective: "Normalized entities and derived indexes turn the collector into a reusable observation core instead of a one-off dashboard backend.",
    groups: [
      {
        heading: "A. Entity counts",
        items: Object.entries(counts).map(([name, count]) => derivedItem(`${name}: ${count}`, "deriveEntityStore()", collectedAt)),
      },
      {
        heading: "B. Derived indexes",
        items: [
          derivedItem(`hot repos: ${entityStore.indexes.hotRepos.length}`, "deriveEntityStore()", collectedAt),
          derivedItem(`http ports: ${entityStore.indexes.httpPorts.length}`, "deriveEntityStore()", collectedAt),
          derivedItem(`active panes: ${entityStore.indexes.activePanes.length}`, "deriveEntityStore()", collectedAt),
          derivedItem(`relations: ${entityStore.relations.length}`, "deriveEntityStore()", collectedAt),
        ],
      },
    ],
    subrubrics: [
      runbook("Entity API Queries", [
        "curl -sS http://127.0.0.1:8091/api/state | jq '.entityStore.indexes'",
        "curl -sS http://127.0.0.1:8091/api/state | jq '.entityStore.entities.repo[:5]'",
      ]),
    ],
  };
}

async function collectSnapshot() {
  const collectedAt = toIsoNow();
  const [disk, memory, topProcesses, ports, ingress, services, tmux, repos, siblings] = await Promise.all([
    collectDisk(),
    collectMemory(),
    collectTopProcesses(),
    collectPorts(),
    collectIngress(),
    collectServices(),
    collectTmux(),
    collectRepos(),
    collectSiblingIntegrations(collectedAt),
  ]);

  const host = {
    hostname: os.hostname(),
    uptimeSeconds: os.uptime(),
    load: os.loadavg(),
    mem: memory.data?.mem || { total: os.totalmem(), used: os.totalmem() - os.freemem(), free: os.freemem(), available: os.freemem() },
    swap: memory.data?.swap || { total: 0, used: 0 },
    disk: disk.data || { total: 0, used: 0, avail: 0, usePct: 0 },
    sources: {
      uptime: "os.uptime()",
      load: "os.loadavg()",
      memory: memory.data ? "free -b" : "os.totalmem()/os.freemem()",
      swap: memory.data ? "free -b" : "unavailable",
      disk: disk.data ? "df -B1 /" : "unavailable",
      topProcesses: topProcesses.diag.ok ? "ps -eo pid,comm,%cpu,%mem,etime,args --sort=-%cpu" : "unavailable",
    },
    confidence: {
      memory: memory.data ? "measured" : "derived",
      swap: memory.data ? "measured" : "unknown",
      disk: disk.data ? "measured" : "unknown",
      topProcesses: topProcesses.diag.ok ? "measured" : "unknown",
    },
  };

  const diagnostics = {
    disk: disk.diag,
    memory: memory.diag,
    processes: topProcesses.diag,
    ports: ports.diag,
    ingress: ingress.diag,
    services: services.diag,
    tmux: tmux.diag,
    repos: repos.diag,
    siblings: siblings.diag,
  };

  const hostSection = summarizeHost(host, topProcesses.data, collectedAt);
  const portsSection = summarizePorts(ports.data, collectedAt);
  const ingressSection = summarizeIngress(ingress.data, ports.data, collectedAt);
  const servicesSection = summarizeServices(services.data, ports.data, collectedAt);
  const tmuxSection = summarizeTmux(tmux.data, collectedAt);
  const reposSection = summarizeRepos(repos.data || [], collectedAt, repos.sampledAt);
  const siblingsSection = summarizeSiblings(siblings.data || [], collectedAt);
  const deployment = deriveDeployment(ingress.data, ports.data, repos.data || []);
  const entityStore = deriveEntityStore({
    host,
    ports: ports.data,
    services: services.data,
    tmux: tmux.data,
    repos: repos.data || [],
    siblings: siblings.data || [],
  });
  const entitySection = summarizeEntityModel(entityStore, collectedAt);
  const verdictSection = summarizeVerdict(hostSection, portsSection, servicesSection, tmuxSection, reposSection, diagnostics, collectedAt);

  const sections = [
    { id: "host", label: "I. HOST SNAPSHOT", sublabel: "Uptime, load, memory, disk", ...hostSection },
    { id: "ports", label: "II. OPEN PORTS & WEB APPS", sublabel: "Sockets and loopback probes", ...portsSection },
    { id: "ingress", label: "III. INGRESS & HOSTNAMES", sublabel: "Caddy, nginx, and reverse-proxy truth", ...ingressSection },
    {
      id: "services",
      label: "IV. SERVICES",
      sublabel: "Managed units vs detached listeners",
      ...servicesSection,
    },
    { id: "deployment", label: "V. DEPLOYMENT ANSWERS", sublabel: "Can this machine serve several apps cleanly?", ...{
      status: deployment.subdomainOk ? "READYING" : "PARTIAL",
      statusColor: deployment.subdomainOk ? "#34C759" : "#FF9500",
      attention: clamp((ingressSection.attention + reposSection.attention) / 2),
      objective: "Operator-facing answers derived from observed ingress, listeners, and repo hygiene. This is the section that should answer deployment questions without handwaving.",
      groups: [
        {
          heading: "A. Public serving truth",
          items: [
            derivedItem(`server-state-report: ${deployment.serverStateReportAnswer}`, "deriveDeployment()", collectedAt),
            derivedItem(deployment.serverStateReportDetail, "deriveDeployment()", collectedAt),
            derivedItem(`public URL: ${deployment.publicUrl || "not observed"}`, "deriveDeployment()", collectedAt),
          ],
        },
        {
          heading: "B. Proxy and subdomain posture",
          items: [
            derivedItem(`proxy posture: ${deployment.proxyAnswer}`, "deriveDeployment()", collectedAt),
            derivedItem(deployment.proxyDetail, "deriveDeployment()", collectedAt),
            derivedItem(`subdomain readiness: ${deployment.subdomainAnswer}`, "deriveDeployment()", collectedAt),
            derivedItem(deployment.subdomainDetail, "deriveDeployment()", collectedAt),
          ],
        },
      ],
      subrubrics: [
        runbook("Public Route Checks", [
          "curl -sS -I http://127.0.0.1:8091/",
          deployment.publicUrl ? `curl -sS -I ${deployment.publicUrl}` : "echo 'no public URL observed yet'",
        ]),
        runbook("Ingress Files", [`sed -n '1,220p' ${CADDYFILE_PATH}`, `find ${NGINX_SITES_ENABLED} ${NGINX_CONF_D} -maxdepth 1 -type f 2>/dev/null | sort`]),
      ],
    } },
    { id: "tmux", label: "VI. TMUX / AGENT MESH", sublabel: "Panes, logs, and observation noise", ...tmuxSection },
    { id: "repos", label: "VII. REPO DRIFT", sublabel: "Fast-forward candidates vs dirty trees", ...reposSection },
    { id: "siblings", label: "VIII. SIBLING INTEGRATIONS", sublabel: "tmuxdesk + corpora-interfaces adapters", ...siblingsSection },
    { id: "entity-model", label: "IX. ENTITY MODEL", sublabel: "Normalized entities, relations, and indexes", ...entitySection },
    { id: "verdict", label: "X. OBSERVATION SURFACE", sublabel: "Freshness, validity, and priority", ...verdictSection },
  ];

  const normalizedSections = normalizeSections(sections, collectedAt);

  const histories = {};
  for (const section of normalizedSections) {
    histories[section.id] = addSectionHistory(section.id, section.attention);
  }

  return {
    collectedAt,
    host,
    topProcesses: topProcesses.data,
    ports: ports.data,
    ingress: {
      ...ingress.data,
      publicUrl: deployment.publicUrl,
    },
    deployment,
    services: services.data,
    tmux: tmux.data,
    repos: repos.data || [],
    siblings: siblings.data || [],
    entityStore,
    diagnostics,
    sections: normalizedSections,
    histories,
  };
}

function deriveEvents(snapshot) {
  const events = [];
  const failedSources = Object.values(snapshot.diagnostics).filter((entry) => !entry.ok);
  const stalenessMs = Date.now() - Date.parse(snapshot.collectedAt);
  if (failedSources.length) {
    events.push({ msg: `ALERT ${failedSources.length} source probe(s) failing`, color: "#FF3B30" });
  }
  if (stalenessMs > STALE_AFTER_MS) {
    events.push({ msg: `ALERT snapshot stale ${stalenessMs}ms`, color: "#FF3B30" });
  }
  if (snapshot.sections.find((section) => section.id === "repos")?.counts?.dirty) {
    events.push({ msg: `WARN ${snapshot.sections.find((section) => section.id === "repos").counts.dirty} dirty upstream-backed repos`, color: "#FF9500" });
  }
  if ((snapshot.tmux.utcWarnings || 0) > 0) {
    events.push({ msg: `WARN agenty status log contains ${snapshot.tmux.utcWarnings} datetime.utcnow warnings`, color: "#AF52DE" });
  }
  if (!events.length) {
    events.push({ msg: "OK collector healthy and all source probes green", color: "#34C759" });
  }
  return events.slice(0, 5);
}

function diffAndTrace(previous, next) {
  if (!previous) {
    appendTrace("verdict", "initial snapshot collected", "ok");
    return;
  }

  if (previous.ports.length !== next.ports.length) {
    appendTrace("ports", `listener count changed ${previous.ports.length} -> ${next.ports.length}`, "warn");
  }

  const previousDirty = previous.sections.find((section) => section.id === "repos")?.counts?.dirty || 0;
  const nextDirty = next.sections.find((section) => section.id === "repos")?.counts?.dirty || 0;
  if (previousDirty !== nextDirty) {
    appendTrace("repos", `dirty upstream-backed repos changed ${previousDirty} -> ${nextDirty}`, nextDirty > previousDirty ? "error" : "ok");
  }

  const previousWarnings = previous.tmux.utcWarnings || 0;
  const nextWarnings = next.tmux.utcWarnings || 0;
  if (previousWarnings !== nextWarnings) {
    appendTrace("tmux", `agenty utcnow warnings changed ${previousWarnings} -> ${nextWarnings}`, nextWarnings > previousWarnings ? "warn" : "ok");
  }

  const previousLoad = previous.host.load[0];
  const nextLoad = next.host.load[0];
  if (Math.abs(previousLoad - nextLoad) > 0.15) {
    appendTrace("host", `loadavg1 moved ${previousLoad.toFixed(2)} -> ${nextLoad.toFixed(2)}`, nextLoad > previousLoad ? "warn" : "info");
  }
}

async function updateSnapshot() {
  if (state.collector.collecting) {
    return;
  }

  state.collector.collecting = true;
  const startedAt = Date.now();
  try {
    const snapshot = await collectSnapshot();
    diffAndTrace(state.snapshot, snapshot);
    state.snapshot = {
      ...snapshot,
      traces: state.traces,
      events: deriveEvents(snapshot),
      stalenessMs: 0,
      revision: ++state.revision,
      meta: {
        collectorStartedAt: state.collector.startedAt,
        staleAfterMs: STALE_AFTER_MS,
      },
    };
    const validation = validateSnapshot(state.snapshot);
    if (!validation.ok) {
      throw new Error(`snapshot validation failed: ${validation.errors.slice(0, 4).join("; ")}`);
    }
    state.collector.lastCollectedAt = snapshot.collectedAt;
    state.lastSuccessfulSnapshotAt = snapshot.collectedAt;
    state.collector.lastDurationMs = Date.now() - startedAt;
    state.collector.consecutiveFailures = 0;
    state.collector.errors = [];
  } catch (error) {
    state.collector.errors.unshift(`${toIsoNow()} ${error.message}`);
    state.collector.errors = state.collector.errors.slice(0, MAX_ERRORS);
    state.collector.lastDurationMs = Date.now() - startedAt;
    state.collector.consecutiveFailures += 1;
    appendTrace("verdict", `collector error: ${error.message}`, "error");
  } finally {
    state.collector.collecting = false;
  }
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, securityHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(payload));
}

function isRateLimited(ip) {
  const now = Date.now();
  const windowStart = now - MAX_API_RPS_WINDOW_MS;
  const entries = (apiRate.get(ip) || []).filter((timestamp) => timestamp >= windowStart);
  entries.push(now);
  apiRate.set(ip, entries);
  return entries.length > MAX_API_REQUESTS_PER_WINDOW;
}

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const candidate = pathname === "/" ? "/index.html" : pathname;
  const normalized = path.normalize(candidate).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(DIST_DIR, normalized);

  if (!filePath.startsWith(DIST_DIR)) {
    response.writeHead(403, securityHeaders("text/plain; charset=utf-8"));
    response.end("forbidden");
    return;
  }

  const ext = path.extname(filePath);
  if (candidate !== "/index.html" && !STATIC_EXTENSIONS.has(ext)) {
    const indexFile = await readFile(path.join(DIST_DIR, "index.html"));
    response.writeHead(200, securityHeaders("text/html; charset=utf-8"));
    response.end(indexFile);
    return;
  }

  try {
    const file = await readFile(filePath);
    response.writeHead(200, securityHeaders(mimeTypes[ext] || "application/octet-stream"));
    response.end(file);
  } catch {
    try {
      const indexFile = await readFile(path.join(DIST_DIR, "index.html"));
      response.writeHead(200, securityHeaders("text/html; charset=utf-8"));
      response.end(indexFile);
    } catch {
      response.writeHead(404, securityHeaders("text/plain; charset=utf-8"));
      response.end("not found");
    }
  }
}

const server = http.createServer(async (request, response) => {
  if (!request.url || !request.method) {
    response.writeHead(400, securityHeaders("text/plain; charset=utf-8"));
    response.end("bad request");
    return;
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, {
      ...securityHeaders("text/plain; charset=utf-8"),
      Allow: "GET, HEAD",
    });
    response.end("method not allowed");
    return;
  }

  const ip = request.socket.remoteAddress || "unknown";
  if (request.url.startsWith("/api/") && isRateLimited(ip)) {
    response.writeHead(429, securityHeaders("text/plain; charset=utf-8"));
    response.end("rate limited");
    return;
  }

  if (request.url.startsWith("/api/state")) {
    if (!state.snapshot) {
      await updateSnapshot();
    }
    const status = collectorStatusSummary();
    if (!state.snapshot) {
      const payload = {
        collectedAt: null,
        stalenessMs: null,
        diagnostics: {},
        traces: state.traces,
        events: [{ msg: "collector has not produced a snapshot yet", color: "#FF3B30" }],
        collector: {
          ...state.collector,
          errors: summarizeErrors(),
        },
        status,
      };
      if (request.method === "HEAD") {
        response.writeHead(503, securityHeaders("application/json; charset=utf-8"));
        response.end();
        return;
      }
      json(response, 503, payload);
      return;
    }
    const payload = {
      ...state.snapshot,
      collectedAt: state.snapshot?.collectedAt || null,
      stalenessMs: state.snapshot?.collectedAt ? Date.now() - Date.parse(state.snapshot.collectedAt) : null,
      collector: {
        ...state.collector,
        errors: summarizeErrors(),
      },
      status,
    };
    if (request.method === "HEAD") {
      response.writeHead(200, securityHeaders("application/json; charset=utf-8"));
      response.end();
      return;
    }
    json(response, 200, payload);
    return;
  }

  if (request.method === "HEAD") {
    response.writeHead(200, securityHeaders("text/html; charset=utf-8"));
    response.end();
    return;
  }

  await serveStatic(request, response);
});

await updateSnapshot();
setInterval(updateSnapshot, COLLECT_INTERVAL_MS);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`server-state-report listening on http://0.0.0.0:${PORT}`);
});
