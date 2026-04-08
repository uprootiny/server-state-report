import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, readdir, readlink, stat } from "node:fs/promises";
import { execFile } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "dist");
const PORT = Number(process.env.PORT || 8091);
const COLLECT_INTERVAL_MS = 10000;
const REPO_REFRESH_MS = 60000;
const MAX_HISTORY = 60;
const MAX_TRACES = 200;

const state = {
  snapshot: null,
  traces: [],
  sequence: 0,
  lastRepoScanAt: 0,
  repoSnapshot: null,
  collector: {
    startedAt: new Date().toISOString(),
    lastCollectedAt: null,
    collecting: false,
    errors: [],
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

function shell(command, timeout = 8000) {
  return new Promise((resolve) => {
    execFile("bash", ["-lc", command], { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code: error?.code ?? 0,
        signal: error?.signal ?? null,
      });
    });
  });
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

async function collectDisk() {
  const result = await shell("df -B1 / | tail -n 1");
  if (!result.ok || !result.stdout) {
    return {
      data: null,
      diag: diagnostic(false, result.stderr || "disk probe failed"),
    };
  }

  const parts = result.stdout.split(/\s+/);
  const total = Number(parts[1]);
  const used = Number(parts[2]);
  const avail = Number(parts[3]);
  const usePct = Number((parts[4] || "0").replace("%", "")) / 100;
  return {
    data: { total, used, avail, usePct },
    diag: diagnostic(true, `disk probe ok (${parts[0]})`),
  };
}

async function collectTopProcesses() {
  const result = await shell("ps -eo pid,comm,%cpu,%mem,etime,args --sort=-%cpu | head -n 8");
  if (!result.ok || !result.stdout) {
    return {
      data: [],
      diag: diagnostic(false, result.stderr || "ps probe failed"),
    };
  }

  const lines = result.stdout.split("\n").slice(1);
  return {
    data: lines.map((line) => {
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
    }).filter(Boolean),
    diag: diagnostic(true, "process probe ok"),
  };
}

async function collectPorts() {
  const result = await shell("ss -ltnpH");
  if (!result.ok) {
    return {
      data: [],
      diag: diagnostic(false, result.stderr || "ss probe failed"),
    };
  }

  const lines = result.stdout ? result.stdout.split("\n") : [];
  const ports = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) {
      continue;
    }
    const localAddress = parts[3];
    const portText = localAddress.slice(localAddress.lastIndexOf(":") + 1);
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

    ports.push({
      address: localAddress,
      port: Number(portText),
      process: processMatch ? processMatch[1] : null,
      pid,
      cwd,
    });
  }

  const probePorts = ports.filter((entry) => [80, 7391, 8090, 8091, 8751, 8901, 17888, 31823].includes(entry.port));
  for (const entry of probePorts) {
    const head = await shell(`curl -sS -I --max-time 2 http://127.0.0.1:${entry.port}`);
    entry.http = {
      ok: head.ok,
      headline: head.stdout.split("\n")[0] || head.stderr || "no response",
    };
  }

  return {
    data: ports.sort((a, b) => a.port - b.port),
    diag: diagnostic(true, `ports probe ok (${ports.length} listeners)`),
  };
}

async function collectServices() {
  const result = await shell("systemctl --user --no-pager --plain --type=service --state=running");
  if (!result.ok) {
    return {
      data: [],
      diag: diagnostic(false, result.stderr || "systemctl probe failed"),
    };
  }

  const services = result.stdout
    .split("\n")
    .filter((line) => line && !line.startsWith("UNIT") && !line.startsWith("Legend:") && !line.includes("loaded units listed."))
    .map((line) => {
      const match = line.match(/^(\S+)\s+loaded\s+active\s+running\s+(.+)$/);
      return match ? { unit: match[1], description: match[2] } : null;
    })
    .filter(Boolean);

  return {
    data: services,
    diag: diagnostic(true, `service probe ok (${services.length} running)`),
  };
}

async function collectTmux() {
  const panesResult = await shell("tmux list-panes -a -F '#S\\t#I.#P\\t#{pane_current_command}\\t#{pane_current_path}'");
  const windowsResult = await shell("tmux list-windows -a");

  const recentLogs = [];
  try {
    const names = await readdir("/home/uprootiny/tmux-logs");
    const stats = await Promise.all(
      names.map(async (name) => {
        const logPath = path.join("/home/uprootiny/tmux-logs", name);
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
    const statusLog = await readFile("/home/uprootiny/agenty/api/status.log", "utf8");
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

  const windows = windowsResult.ok && windowsResult.stdout ? windowsResult.stdout.split("\n") : [];
  const ok = panesResult.ok && windowsResult.ok;

  return {
    data: { panes, windows, recentLogs, utcWarnings },
    diag: diagnostic(ok, ok ? `tmux probe ok (${panes.length} panes)` : panesResult.stderr || windowsResult.stderr),
  };
}

async function refreshRepoSnapshot() {
  const command = `
find /home/uprootiny -mindepth 1 -maxdepth 4 -type d -name .git \
  | sed 's#/\\.git$##' \
  | grep -v '^/home/uprootiny/\\.asdf' \
  | grep -v '^/home/uprootiny/\\.tmux' \
  | grep -v '^/home/uprootiny/\\.codex' \
  | while IFS= read -r repo; do
      remote=$(git -C "$repo" remote get-url origin 2>/dev/null || true)
      branch=$(git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null || git -C "$repo" rev-parse --short HEAD 2>/dev/null)
      dirty=$(git -C "$repo" status --porcelain 2>/dev/null | wc -l)
      upstream=$(git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
      printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$repo" "$branch" "$dirty" "$upstream" "$remote"
    done
`;
  const result = await shell(command, 20000);
  if (!result.ok) {
    return {
      data: state.repoSnapshot,
      diag: diagnostic(false, result.stderr || "repo scan failed"),
    };
  }

  const repos = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [repo, branch, dirty, upstream, remote] = line.split("\t");
      return {
        repo,
        branch,
        dirty: Number(dirty),
        upstream: upstream || null,
        remote: remote || null,
      };
    });

  state.repoSnapshot = repos;
  state.lastRepoScanAt = Date.now();
  return {
    data: repos,
    diag: diagnostic(true, `repo scan ok (${repos.length} repos)`),
  };
}

async function collectRepos() {
  if (!state.repoSnapshot || Date.now() - state.lastRepoScanAt > REPO_REFRESH_MS) {
    return refreshRepoSnapshot();
  }
  return {
    data: state.repoSnapshot,
    diag: diagnostic(true, "repo scan reused from cache", { cached: true }),
  };
}

function summarizePorts(ports) {
  const publicPorts = ports.filter((entry) => ![22, 53, 2019, 4369].includes(entry.port));
  const httpPorts = publicPorts.filter((entry) => entry.http || [7391, 8090, 8091, 8751, 8901, 17888, 31823, 80].includes(entry.port));
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
        items: httpPorts.map((entry) => {
          const headline = entry.http?.headline ? `, ${entry.http.headline}` : "";
          return `${entry.port} -> ${entry.process || "unknown"}${entry.cwd ? ` @ ${entry.cwd}` : ""}${headline}`;
        }).slice(0, 10),
      },
      {
        heading: "B. Probe health",
        items: failedProbes.length
          ? failedProbes.map((entry) => `${entry.port} probe failed`)
          : ["All probed HTTP listeners responded on loopback"],
      },
    ],
  };
}

function summarizeHost(host, topProcesses) {
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
          `Uptime: ${formatDuration(host.uptimeSeconds)}`,
          `Load average: ${host.load.map((v) => v.toFixed(2)).join(" / ")}`,
          `Memory: ${formatBytes(host.mem.used)} used / ${formatBytes(host.mem.total)} total, ${formatBytes(host.mem.available)} available`,
          `Swap: ${formatBytes(host.swap.used)} used / ${formatBytes(host.swap.total)} total`,
          `Disk /: ${formatBytes(host.disk.used)} used / ${formatBytes(host.disk.total)} total (${Math.round(host.disk.usePct * 100)}%)`,
        ],
      },
      {
        heading: "B. Top processes",
        items: topProcesses.slice(0, 4).map((proc) => `${proc.command} pid=${proc.pid} cpu=${proc.cpu}% mem=${proc.mem}% elapsed=${proc.elapsed}`),
      },
    ],
  };
}

function summarizeServices(services, ports) {
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
        items: services.length ? services.map((entry) => `${entry.unit} -> ${entry.description}`) : ["No running user services observed"],
      },
      {
        heading: "B. Detached listeners",
        items: detached.slice(0, 6).map((entry) => `${entry.port} -> ${entry.process || "unknown"} @ ${entry.cwd || "cwd unknown"}`),
      },
    ],
  };
}

function summarizeTmux(tmux) {
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
          ? activePanes.slice(0, 8).map((pane) => `${pane.session}:${pane.pane} ${pane.command} @ ${pane.currentPath}`)
          : ["No non-bash panes observed"],
      },
      {
        heading: "B. Observation hazards",
        items: [
          `agenty status log datetime.utcnow warnings: ${tmux.utcWarnings}`,
          ...(tmux.recentLogs.length ? tmux.recentLogs.map((entry) => `recent log: ${entry}`) : ["No tmux logs found"]),
        ].slice(0, 6),
      },
    ],
  };
}

function summarizeRepos(repos) {
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
          ? cleanTracked.slice(0, 10).map((repo) => `${repo.repo} [${repo.branch}] tracking ${repo.upstream}`)
          : ["No clean tracked repos found"],
      },
      {
        heading: "B. Dirty repos needing care",
        items: dirty.length
          ? dirty.slice(0, 10).map((repo) => `${repo.repo} [${repo.branch}] dirty=${repo.dirty}${repo.upstream ? ` upstream=${repo.upstream}` : " upstream=none"}`)
          : ["No dirty repos with origin remotes"],
      },
    ],
    counts: {
      total: repos.length,
      withOrigin: withOrigin.length,
      cleanTracked: cleanTracked.length,
      dirty: dirty.length,
    },
  };
}

function summarizeVerdict(hostSection, portsSection, servicesSection, tmuxSection, reposSection, diagnostics) {
  const failedSources = Object.values(diagnostics).filter((entry) => !entry.ok).length;
  const attention = clamp((hostSection.attention + portsSection.attention + servicesSection.attention + tmuxSection.attention + reposSection.attention) / 5);
  const status = failedSources ? "DEGRADED" : "ACTIONABLE";
  const statusColor = failedSources ? "#FF3B30" : "#FF2D92";

  return {
    status,
    statusColor,
    attention,
    objective: "This report is only trustworthy if collection, validation, and rendering are all fresh and all source probes are explicit.",
    groups: [
      {
        heading: "A. Current state",
        items: [
          `Collector freshness: ${state.collector.lastCollectedAt || "never"}`,
          `Source probes failing: ${failedSources}`,
          `Host pressure index: ${Math.round(hostSection.attention * 100)}%`,
          `Repo drift index: ${Math.round(reposSection.attention * 100)}%`,
        ],
      },
      {
        heading: "B. Priorities",
        items: [
          failedSources ? "Repair failed probes before trusting the report" : "Observation chain is healthy",
          reposSection.counts?.dirty ? "Dirty repos still block safe bulk pulls" : "Repo layer is currently quiet",
          tmuxSection.attention > 0.3 ? "Status/log noise still pollutes observation quality" : "Interactive surfaces are readable",
        ],
      },
    ],
  };
}

async function collectSnapshot() {
  const collectedAt = toIsoNow();
  const [disk, topProcesses, ports, services, tmux, repos] = await Promise.all([
    collectDisk(),
    collectTopProcesses(),
    collectPorts(),
    collectServices(),
    collectTmux(),
    collectRepos(),
  ]);

  const host = {
    hostname: os.hostname(),
    uptimeSeconds: os.uptime(),
    load: os.loadavg(),
    mem: {
      total: os.totalmem(),
      free: os.freemem(),
      available: os.freemem(),
      used: os.totalmem() - os.freemem(),
    },
    swap: {
      total: 0,
      used: 0,
    },
    disk: disk.data || { total: 0, used: 0, avail: 0, usePct: 0 },
  };

  const freeResult = await shell("free -b");
  if (freeResult.ok && freeResult.stdout) {
    const swapLine = freeResult.stdout.split("\n").find((line) => line.startsWith("Swap:"));
    if (swapLine) {
      const parts = swapLine.trim().split(/\s+/);
      host.swap.total = Number(parts[1]);
      host.swap.used = Number(parts[2]);
    }
  }

  const diagnostics = {
    disk: disk.diag,
    processes: topProcesses.diag,
    ports: ports.diag,
    services: services.diag,
    tmux: tmux.diag,
    repos: repos.diag,
    free: diagnostic(freeResult.ok, freeResult.ok ? "memory probe ok" : freeResult.stderr || "free probe failed"),
  };

  const hostSection = summarizeHost(host, topProcesses.data);
  const portsSection = summarizePorts(ports.data);
  const servicesSection = summarizeServices(services.data, ports.data);
  const tmuxSection = summarizeTmux(tmux.data);
  const reposSection = summarizeRepos(repos.data || []);
  const verdictSection = summarizeVerdict(hostSection, portsSection, servicesSection, tmuxSection, reposSection, diagnostics);

  const sections = [
    { id: "host", label: "I. HOST SNAPSHOT", sublabel: "Uptime, load, memory, disk", ...hostSection },
    { id: "ports", label: "II. OPEN PORTS & WEB APPS", sublabel: "Sockets and loopback probes", ...portsSection },
    { id: "services", label: "III. SERVICES", sublabel: "Managed units vs detached listeners", ...servicesSection },
    { id: "tmux", label: "IV. TMUX / AGENT MESH", sublabel: "Panes, logs, and observation noise", ...tmuxSection },
    { id: "repos", label: "V. REPO DRIFT", sublabel: "Fast-forward candidates vs dirty trees", ...reposSection },
    { id: "verdict", label: "VI. OBSERVATION SURFACE", sublabel: "Freshness, validity, and priority", ...verdictSection },
  ];

  const histories = {};
  for (const section of sections) {
    histories[section.id] = addSectionHistory(section.id, section.attention);
  }

  return {
    collectedAt,
    host,
    topProcesses: topProcesses.data,
    ports: ports.data,
    services: services.data,
    tmux: tmux.data,
    repos: repos.data || [],
    diagnostics,
    sections,
    histories,
  };
}

function deriveEvents(snapshot) {
  const events = [];
  const failedSources = Object.values(snapshot.diagnostics).filter((entry) => !entry.ok);
  if (failedSources.length) {
    events.push({ msg: `ALERT ${failedSources.length} source probe(s) failing`, color: "#FF3B30" });
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
  try {
    const snapshot = await collectSnapshot();
    diffAndTrace(state.snapshot, snapshot);
    state.snapshot = {
      ...snapshot,
      traces: state.traces,
      events: deriveEvents(snapshot),
      stalenessMs: 0,
      meta: {
        collectorStartedAt: state.collector.startedAt,
      },
    };
    state.collector.lastCollectedAt = snapshot.collectedAt;
    state.collector.errors = [];
  } catch (error) {
    state.collector.errors.unshift(`${toIsoNow()} ${error.message}`);
    state.collector.errors = state.collector.errors.slice(0, 20);
    appendTrace("verdict", `collector error: ${error.message}`, "error");
  } finally {
    state.collector.collecting = false;
  }
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  let filePath = requestUrl.pathname === "/" ? path.join(DIST_DIR, "index.html") : path.join(DIST_DIR, requestUrl.pathname);

  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(file);
  } catch {
    try {
      const file = await readFile(path.join(DIST_DIR, "index.html"));
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      response.end(file);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  }
}

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    response.writeHead(400);
    response.end("bad request");
    return;
  }

  if (request.url.startsWith("/api/state")) {
    if (!state.snapshot) {
      await updateSnapshot();
    }
    json(response, 200, {
      ...state.snapshot,
      collectedAt: state.snapshot?.collectedAt || null,
      stalenessMs: state.snapshot?.collectedAt ? Date.now() - Date.parse(state.snapshot.collectedAt) : null,
      collector: state.collector,
    });
    return;
  }

  await serveStatic(request, response);
});

await updateSnapshot();
setInterval(updateSnapshot, COLLECT_INTERVAL_MS);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`server-state-report listening on http://0.0.0.0:${PORT}`);
});
