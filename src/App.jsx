import { memo, startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

const RAINBOW = ["#FF3B30", "#FF9500", "#FFD60A", "#34C759", "#30D5C8", "#007AFF", "#AF52DE", "#FF2D92"];
const GITHUB_URL = "https://github.com/uprootiny/server-state-report";
const MONO = 'Menlo, Consolas, "Liberation Mono", monospace';
const DISPLAY = '"Cormorant Garamond", serif';
const PRIMARY_SECTION_ORDER = ["host", "ports", "ingress", "services", "verdict"];
const CONTEXT_SECTION_ORDER = ["deployment", "tmux", "repos", "siblings", "entity-model"];
const USE_MOCK = new URLSearchParams(window.location.search).has("mock");

const DIAGNOSTIC_SECTION_MAP = {
  disk: "host",
  memory: "host",
  processes: "host",
  ports: "ports",
  ingress: "ingress",
  services: "services",
  tmux: "tmux",
  repos: "repos",
  siblings: "siblings",
};

const tones = {
  ok: "#34C759",
  warn: "#FF9500",
  error: "#FF3B30",
  calm: "#30D5C8",
  accent: "#D4A844",
  text: "#D4C8B0",
  dim: "#A99678",
  muted: "#7E6A4B",
  panel: "#110E0A",
  border: "#2B241C",
};

const sx = {
  shell: {
    minHeight: "100vh",
    background: "radial-gradient(ellipse at 25% 5%, #141008 0%, #0A0806 55%, #060405 100%)",
    position: "relative",
    overflow: "hidden",
  },
  page: {
    position: "relative",
    zIndex: 2,
    maxWidth: 920,
    margin: "0 auto",
    padding: "32px 20px 120px",
  },
  panel: {
    background: tones.panel,
    border: `1px solid ${tones.border}`,
  },
  mono8: { fontFamily: MONO, fontSize: 8, letterSpacing: "0.12em" },
  mono9: { fontFamily: MONO, fontSize: 9, letterSpacing: "0.06em" },
  mono10: { fontFamily: MONO, fontSize: 10, letterSpacing: "0.06em" },
  mono11: { fontFamily: MONO, fontSize: 11, letterSpacing: "0.04em" },
  display12: { fontFamily: DISPLAY, fontSize: 12, color: tones.dim },
  display13: { fontFamily: DISPLAY, fontSize: 13, color: tones.dim },
};

function toneFor(flag, okTone = tones.ok, badTone = tones.error) {
  return flag ? okTone : badTone;
}

function buildMockState() {
  const now = new Date();
  const histories = {
    host: [0.39, 0.41, 0.36, 0.44, 0.47, 0.42, 0.45, 0.48],
    ports: [0.32, 0.35, 0.35, 0.34, 0.36],
    ingress: [0.4, 0.42, 0.45, 0.44],
    services: [0.82, 0.86, 0.85, 0.83],
    tmux: [0.92, 0.95, 0.98, 1],
    repos: [0.9, 0.94, 0.97, 1],
    siblings: [0.2, 0.22, 0.18, 0.21],
    "entity-model": [0.6, 0.64, 0.62, 0.6],
    deployment: [0.7, 0.72, 0.68, 0.73],
    verdict: [0.76, 0.78, 0.74, 0.77],
  };

  return {
    revision: 1,
    collectedAt: now.toISOString(),
    stalenessMs: 0,
    meta: { staleAfterMs: 6000 },
    host: {
      hostname: "vmi2545689",
      load: [1.33, 0.95, 0.79],
      uptimeSeconds: 7410000,
      mem: { total: 12541571072, used: 3970000000, free: 8000000000, available: 9000000000 },
    },
    ingress: {
      publicUrl: "https://observe.raindesk.dev",
    },
    status: {
      ready: true,
      healthy: true,
      consecutiveFailures: 0,
    },
    collector: {
      startedAt: new Date(now.getTime() - 3600 * 1000).toISOString(),
    },
    diagnostics: {
      disk: { ok: true, detail: "disk probe ok (/dev/sda1)", checkedAt: now.toISOString() },
      memory: { ok: true, detail: "memory probe ok", checkedAt: now.toISOString() },
      processes: { ok: true, detail: "process probe ok", checkedAt: now.toISOString() },
      ports: { ok: true, detail: "ports probe ok (16 listeners)", checkedAt: now.toISOString() },
      ingress: { ok: true, detail: "ingress probe ok", checkedAt: now.toISOString() },
      services: { ok: true, detail: "service probe ok (2 running)", checkedAt: now.toISOString() },
      tmux: { ok: true, detail: "tmux probe ok (20 panes)", checkedAt: now.toISOString() },
      repos: { ok: true, detail: "repo scan reused from cache", checkedAt: now.toISOString() },
      siblings: { ok: true, detail: "sibling adapter probe ok (2 adapters)", checkedAt: now.toISOString() },
    },
    histories,
    traces: [
      { seq: 1, ts: now.toISOString(), severity: "warn", section: "host", msg: "loadavg1 moved 1.27 -> 1.45" },
      { seq: 2, ts: new Date(now.getTime() - 22000).toISOString(), severity: "warn", section: "host", msg: "loadavg1 moved 1.12 -> 1.31" },
      { seq: 3, ts: new Date(now.getTime() - 65000).toISOString(), severity: "warn", section: "host", msg: "loadavg1 moved 0.80 -> 1.41" },
      { seq: 4, ts: new Date(now.getTime() - 120000).toISOString(), severity: "warn", section: "host", msg: "loadavg1 moved 0.63 -> 0.90" },
      { seq: 5, ts: new Date(now.getTime() - 128000).toISOString(), severity: "info", section: "host", msg: "loadavg1 moved 0.81 -> 0.63" },
    ],
    events: [{ msg: "WARN 12 dirty upstream-backed repos", color: tones.warn }],
    ports: [
      { port: 80, result: "HTTP/1.1 308 Permanent Redirect" },
      { port: 7391, result: "HTTP/1.1 200 OK" },
      { port: 8090, result: "HTTP/1.0 200 OK" },
      { port: 8091, result: "HTTP/1.1 200 OK" },
    ],
    repos: [
      { path: "/home/uprootiny/fie", dirty: 680, branch: "main", upstream: "origin/main" },
      { path: "/home/uprootiny/server-state-report", dirty: 7, branch: "main", upstream: "origin/main" },
    ],
    tmux: {
      panes: [{ command: "claude" }, { command: "codex" }, { command: "bash" }],
      utcWarnings: 44,
    },
    siblings: [
      { id: "tmuxdesk", status: "DIRTY" },
      { id: "corpora", status: "READY" },
    ],
    deployment: {
      serverStateReportOk: true,
      serverStateReportAnswer: "yes, this host exposes it",
      serverStateReportDetail: "Observed hostname observe.raindesk.dev -> reverse_proxy localhost:8091",
      proxyOk: true,
      proxyAnswer: "caddy is the active ingress",
      proxyDetail: "Caddy config present with 79 hostnames and 5 reverse_proxy targets",
      subdomainOk: true,
      subdomainAnswer: "subdomain readiness: 79 hostnames discovered",
      subdomainDetail: "Deployment capacity exists, repo hygiene still matters",
    },
    sections: [
      {
        id: "host",
        label: "I. HOST SNAPSHOT",
        sublabel: "Uptime, load, memory, disk",
        status: "STABLE",
        statusColor: tones.ok,
        attention: 0.39,
        objective: "Resource pressure from kernel uptime, load averages, memory, disk, and top CPU processes.",
        groups: [
          {
            heading: "A. Capacity",
            items: [
              "Uptime: 85d 15h 34m",
              "Load average: 1.33 / 0.95 / 0.79",
              "Memory: 3.7 GiB used / 11.7 GiB total, 8.0 GiB available",
              "Swap: 329.2 MiB used / 4.0 GiB total",
              "Disk /: 193.7 GiB used / 289.6 GiB total (67%)",
            ],
          },
          {
            heading: "B. Top processes",
            items: ["ps pid=2255445 cpu=300% mem=0% elapsed=00:00", "systemctl pid=2255447 cpu=100% mem=0% elapsed=00:00"],
          },
        ],
        subrubrics: [
          {
            title: "Host Pressure Checks",
            commands: ["uptime", "free -h", "df -h", "ps aux --sort=-%cpu | head"],
          },
        ],
      },
      {
        id: "ports",
        label: "II. OPEN PORTS & WEB APPS",
        sublabel: "Sockets and loopback probes",
        status: "LIVE",
        statusColor: tones.calm,
        attention: 0.35,
        objective: "Listening sockets and HTTP probes from the current host snapshot.",
        groups: [
          {
            heading: "A. HTTP listeners",
            items: ["80 -> unknown, HTTP/1.1 308 Permanent Redirect", "8091 -> MainThread @ /home/uprootiny/server-state-report, HTTP/1.1 200 OK"],
          },
          {
            heading: "B. Probe health",
            items: ["All probed HTTP listeners responded on loopback"],
          },
        ],
        subrubrics: [
          {
            title: "Loopback Checks",
            commands: ["curl -s http://localhost:8091/api/state | jq ."],
          },
          {
            title: "Port Ownership",
            commands: ["ss -ltnp | rg 8091"],
          },
        ],
      },
      {
        id: "ingress",
        label: "III. INGRESS & HOSTNAMES",
        sublabel: "Caddy, nginx, and reverse-proxy truth",
        status: "MISWIRED",
        statusColor: tones.error,
        attention: 0.45,
        objective: "Ingress truth: which proxy is active, which hostnames are configured, and whether reverse-proxy targets land on live listeners.",
        groups: [
          { heading: "A. Proxy daemons", items: ["Caddy: running @ /etc/caddy/Caddyfile", "nginx: inactive"] },
          {
            heading: "B. Hostname and route surface",
            items: ["Caddy host: observe.raindesk.dev", "reverse_proxy -> localhost:8752 missing listener", "reverse_proxy -> localhost:8751 ok"],
          },
        ],
        subrubrics: [
          { title: "Ingress Truth", commands: ["caddy validate --config /etc/caddy/Caddyfile"] },
          { title: "Virtual Host Audit", commands: ["rg \"reverse_proxy\" /etc/caddy/Caddyfile"] },
        ],
      },
      {
        id: "services",
        label: "IV. SERVICES",
        sublabel: "Managed units vs detached listeners",
        status: "OBSERVED",
        statusColor: tones.warn,
        attention: 0.86,
        objective: "Managed user services plus detached listeners that are not supervised by systemd --user.",
        groups: [
          { heading: "A. Running user services", items: ["dbus.service -> D-Bus User Message Bus", "febbity.service -> Fibration Flow Clojure demo"] },
          { heading: "B. Detached listeners", items: ["8091 -> MainThread @ /home/uprootiny/server-state-report"] },
        ],
        subrubrics: [{ title: "Service Health", commands: ["systemctl --user --failed", "systemctl --user list-units --type=service"] }],
      },
      {
        id: "verdict",
        label: "X. OBSERVATION SURFACE",
        sublabel: "Freshness, validity, and priority",
        status: "ACTIONABLE",
        statusColor: tones.warn,
        attention: 0.72,
        objective: "This report is only trustworthy if collection, validation, rendering freshness, and source probes all remain explicit.",
        groups: [
          {
            heading: "A. Current state",
            items: [
              `Collector freshness: ${now.toISOString()}`,
              "Snapshot staleness: 285 ms",
              "Source probes failing: 0",
              "Host pressure index: 39%",
              "Repo drift index: 100%",
            ],
          },
          {
            heading: "B. Priorities",
            items: ["Collector freshness is within threshold", "Observation chain is healthy", "Dirty repos still block safe bulk pulls"],
          },
        ],
        subrubrics: [
          { title: "Observation Surface Verification", commands: ["curl -s http://localhost:8091/api/state | jq .status"] },
          { title: "Collector Logs", commands: ["tail -n 200 ~/server-state-report/collector.log"] },
        ],
      },
      {
        id: "deployment",
        label: "V. DEPLOYMENT ANSWERS",
        sublabel: "Can this machine serve several apps cleanly?",
        status: "READYING",
        statusColor: tones.ok,
        attention: 0.73,
        objective: "Operator-facing answers derived from observed ingress, listeners, and repo hygiene.",
        groups: [
          { heading: "A. Public serving truth", items: ["server-state-report: yes, this host exposes it", "public URL: https://observe.raindesk.dev"] },
          { heading: "B. Proxy posture", items: ["proxy posture: caddy is the active ingress", "26 dirty repos on host; deployment capacity exists"] },
        ],
        subrubrics: [
          { title: "Public Route Checks", commands: ["curl -I https://observe.raindesk.dev"] },
          { title: "Ingress Files", commands: ["ls /etc/caddy", "ls /etc/nginx/sites-enabled"] },
        ],
      },
      {
        id: "tmux",
        label: "VI. TMUX / AGENT MESH",
        sublabel: "Panes, logs, and observation noise",
        status: "ACTIVE",
        statusColor: "#AF52DE",
        attention: 1.0,
        objective: "Current tmux panes plus the quality of nearby status/log surfaces.",
        groups: [
          { heading: "A. Active panes", items: ["10:1.1 claude @ /home/uprootiny/fie", "10:2.1 codex @ /home/uprootiny/fie"] },
          { heading: "B. Observation hazards", items: ["agenty status log datetime.utcnow warnings: 44", "recent log: 10-1773929818.log (16.9 MiB)"] },
        ],
        subrubrics: [
          { title: "Pane Census", commands: ["tmux list-panes -a -F '#S:#I.#P #{pane_current_command} #{pane_current_path}'"] },
          { title: "Log Spot Check", commands: ["ls -lh ~/tmux-logs | tail -n 5"] },
        ],
      },
      {
        id: "repos",
        label: "VII. REPO DRIFT",
        sublabel: "Fast-forward candidates vs dirty trees",
        status: "MIXED",
        statusColor: tones.warn,
        attention: 1.0,
        objective: "Git worktree drift across the workspace, separated into safe fast-forward candidates and repos requiring manual integration.",
        groups: [
          { heading: "A. Clean tracked repos", items: ["/home/uprootiny/arcana [main] tracking origin/main"] },
          { heading: "B. Dirty repos needing care", items: ["/home/uprootiny/fie [main] dirty=680 upstream=origin/main"] },
        ],
        subrubrics: [
          { title: "Safe Pull Workflow", commands: ["git fetch --all --prune", "git status -sb"] },
          { title: "Dirty Tree Audit", commands: ["git diff --stat", "git status -sb"] },
        ],
      },
      {
        id: "siblings",
        label: "VIII. SIBLING INTEGRATIONS",
        sublabel: "tmuxdesk + corpora-interfaces adapters",
        status: "MIXED",
        statusColor: tones.warn,
        attention: 0.2,
        objective: "Sibling project adapters let the observation surface project adjacent systems without hard-coding them into the core collector.",
        groups: [
          { heading: "A. Adapter inventory", items: ["tmuxdesk -> DIRTY", "corpora-interfaces -> READY"] },
          {
            heading: "B. Architectural posture",
            items: ["Sibling probes are isolated adapters, not embedded in the host core", "Each adapter can grow into its own runtime endpoint later"],
          },
        ],
        subrubrics: [
          { title: "tmuxdesk · tmuxdesk Fleet Health", commands: ["cd ~/tmuxdesk && git status -sb"] },
          { title: "corpora-interfaces · corpora-interfaces Boot", commands: ["cd ~/corpora-interfaces && npm start"] },
        ],
      },
      {
        id: "entity-model",
        label: "IX. ENTITY MODEL",
        sublabel: "Normalized entities, relations, and indexes",
        status: "NORMALIZED",
        statusColor: tones.calm,
        attention: 0.6,
        objective: "Normalized entities and derived indexes turn the collector into a reusable observation core.",
        groups: [
          { heading: "A. Entity counts", items: ["host: 1", "port: 16", "service: 2", "pane: 20", "repo: 40", "adapter: 2"] },
          { heading: "B. Derived indexes", items: ["hot repos: 5", "http ports: 8", "active panes: 9", "relations: 85"] },
        ],
        subrubrics: [{ title: "Entity API Queries", commands: ["curl -s http://localhost:8091/api/entities | jq ."] }],
      },
    ],
  };
}

function evolveMockState(prev) {
  const next = { ...prev };
  const now = new Date();
  next.revision = (prev.revision || 1) + 1;
  next.collectedAt = now.toISOString();
  next.stalenessMs = 0;
  next.traces = [
    {
      seq: next.revision,
      ts: now.toISOString(),
      severity: "warn",
      section: "host",
      msg: `loadavg1 moved ${Math.random().toFixed(2)} -> ${Math.random().toFixed(2)}`,
    },
    ...(prev.traces || []),
  ].slice(0, 8);
  next.histories = Object.fromEntries(
    Object.entries(prev.histories || {}).map(([key, values]) => {
      const last = values[values.length - 1] ?? 0.5;
      const jitter = Math.max(0, Math.min(1, last + (Math.random() - 0.5) * 0.08));
      return [key, [...values.slice(-9), jitter]];
    })
  );
  return next;
}

function formatTimestamp(value) {
  if (!value) {
    return "unknown";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().replace("T", " ").slice(0, 19);
}

function Sparkline({ data, color, width = 84, height = 22 }) {
  if (!data || data.length < 2) {
    return <span style={{ ...sx.mono9, color }}>--</span>;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map((value, index) => {
    const x = (index / (data.length - 1)) * (width - 4);
    const y = height - 4 - ((value - min) / range) * (height - 8);
    return `${x},${y}`;
  });
  const last = data[data.length - 1];
  const prev = data[data.length - 2];
  const trend = last > prev + 0.03 ? "^" : last < prev - 0.03 ? "v" : "~";

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <svg width={width} height={height}>
        <polyline points={points.join(" ")} fill="none" stroke={`${color}77`} strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <circle cx={Number(points[points.length - 1].split(",")[0])} cy={Number(points[points.length - 1].split(",")[1])} r="2" fill={color} />
      </svg>
      <span style={{ ...sx.mono9, color }}>
        {Math.round(last * 100)}% {trend}
      </span>
    </span>
  );
}

function AgentPulse({ value, color, history }) {
  const blinkRate = value > 0.85 ? `${0.4 + value * 0.5}s` : `${1.1 + (1 - value) * 1.6}s`;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span
        style={{
          display: "inline-block",
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: color,
          boxShadow: `0 0 6px ${color}, 0 0 14px ${color}44`,
          animation: `agentPulse ${blinkRate} ease-in-out infinite`,
          opacity: 0.35 + value * 0.65,
        }}
      />
      <Sparkline data={history} color={color} width={56} height={16} />
    </span>
  );
}

const TraceWaterfall = memo(function TraceWaterfall({ traces = [] }) {
  const colors = { error: tones.error, warn: tones.warn, info: "#8A816F", ok: tones.ok };
  const icons = { error: "o", warn: "O", info: "-", ok: "+" };

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 1,
        pointerEvents: "none",
        height: 92,
        overflow: "hidden",
        background: "linear-gradient(0deg, #0A0806EE 0%, transparent 100%)",
      }}
    >
      <div style={{ position: "absolute", bottom: 4, left: 12, right: 12, display: "flex", flexDirection: "column-reverse" }}>
        {traces.slice(0, 6).map((trace, index) => (
          <div
            key={`${trace.seq}-${trace.ts}`}
            style={{
              ...sx.mono9,
              color: colors[trace.severity] || "#777",
              opacity: 0.32 + (1 - index / 6) * 0.68,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              lineHeight: 1.6,
            }}
          >
            <span style={{ color: `${colors[trace.severity] || "#777"}66` }}>{icons[trace.severity] || "-"}</span>{" "}
            [{new Date(trace.ts).toISOString().slice(11, 23)}]{" "}
            <span style={{ color: `${RAINBOW[index % RAINBOW.length]}88` }}>{trace.section}</span> {trace.msg}
          </div>
        ))}
      </div>
    </div>
  );
});

const Subrubric = memo(function Subrubric({ item, accent }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ borderTop: `1px solid ${accent}15`, paddingTop: 8, marginTop: 8 }}>
      <button
        onClick={() => setOpen((value) => !value)}
        style={{
          width: "100%",
          background: "none",
          border: "none",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          color: "#9B8767",
          ...sx.mono9,
          textAlign: "left",
          padding: "4px 0",
        }}
      >
        <span>{item.title}</span>
        <span style={{ color: accent }}>{open ? "▼" : "▶"}</span>
      </button>
      {open ? (
        <div style={{ marginTop: 6, paddingLeft: 8 }}>
          {item.commands.map((command) => (
            <div key={command} style={{ ...sx.mono10, color: "#BCAE93", lineHeight: 1.7, wordBreak: "break-word" }}>
              <code>{command}</code>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
});

function GroupList({ heading, items, color }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ ...sx.mono9, color, marginBottom: 5, opacity: 0.8 }}>{heading}</div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {items.map((item, index) => (
          <li
            key={`${heading}-${index}`}
            style={{
              ...sx.mono10,
              color: "#C0B8A0CC",
              lineHeight: 1.7,
              paddingLeft: 14,
              position: "relative",
              marginBottom: 1,
            }}
          >
            <span style={{ position: "absolute", left: 0, color: `${color}66`, fontSize: 10 }}>·</span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

const AccordionSection = memo(function AccordionSection({ section, color, isOpen, onToggle, history }) {
  const contentRef = useRef(null);
  const [height, setHeight] = useState(0);
  const avg = section.attention || 0;
  const isBottleneck = avg > 0.8;

  useEffect(() => {
    if (contentRef.current) {
      setHeight(isOpen ? contentRef.current.scrollHeight : 0);
    }
  }, [isOpen, section]);

  return (
    <div
      style={{
        marginBottom: 2,
        border: `1px solid ${color}1A`,
        borderLeft: `3px solid ${color}`,
        background: `rgba(12, 10, 8, ${0.82 + (isOpen ? 0.08 : 0)})`,
        boxShadow: isOpen ? `0 0 24px ${color}14, inset 0 0 40px ${color}06` : `0 0 6px ${color}06`,
      }}
    >
      <button
        onClick={onToggle}
        style={{
          width: "100%",
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "13px 18px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          textAlign: "left",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 700, color, letterSpacing: "0.12em" }}>{section.label}</span>
          <span style={{ fontFamily: DISPLAY, fontSize: 11.5, color: `${color}88`, fontStyle: "italic" }}>{section.sublabel}</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {isBottleneck ? (
            <span
              style={{
                ...sx.mono8,
                color: tones.error,
                border: `1px solid ${tones.error}44`,
                padding: "1px 5px",
                background: `${tones.error}08`,
              }}
            >
              BOTTLENECK
            </span>
          ) : null}
          <span
            style={{
              ...sx.mono9,
              color: section.statusColor,
              border: `1px solid ${section.statusColor}44`,
              padding: "2px 6px",
              background: `${section.statusColor}0C`,
            }}
          >
            {section.status}
          </span>
          <AgentPulse value={avg} color={color} history={history} />
          <span style={{ color, fontSize: 14, transform: isOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.3s ease" }}>▶</span>
        </div>
      </button>

      <div style={{ height, overflow: "hidden", transition: "height 0.35s cubic-bezier(0.4,0,0.2,1)" }}>
        <div ref={contentRef} style={{ padding: "0 18px 16px 18px", contentVisibility: "auto", containIntrinsicSize: "500px" }}>
          <p
            style={{
              fontFamily: DISPLAY,
              fontSize: 13.5,
              color: "#D0C4A8CC",
              lineHeight: 1.6,
              margin: "0 0 14px 0",
              borderLeft: `2px solid ${color}33`,
              paddingLeft: 10,
              fontStyle: "italic",
            }}
          >
            {section.objective}
          </p>

          {history?.length > 1 ? (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ ...sx.mono8, color: "#555" }}>ATTENTION HISTORY</span>
                <svg width={140} height={18} style={{ flexShrink: 0 }}>
                  {history.map((value, index) => {
                    const x = (index / history.length) * 138;
                    const barHeight = Math.max(1, value * 16);
                    const hueIndex = Math.floor(value * (RAINBOW.length - 1));
                    return <rect key={index} x={x} y={18 - barHeight} width={3} height={barHeight} fill={`${RAINBOW[hueIndex]}44`} rx={1} />;
                  })}
                </svg>
                <span style={{ ...sx.mono8, color }}>p95 {(Math.max(...history) * 100).toFixed(0)}%</span>
              </div>
            </div>
          ) : null}

          {section.groups.map((group) => (
            <GroupList key={group.heading} heading={group.heading} items={group.items} color={color} />
          ))}

          {(section.subrubrics || []).map((item) => (
            <Subrubric key={item.title} item={item} accent={color} />
          ))}
        </div>
      </div>
    </div>
  );
});

function ClickBadge({ children, color, background, borderColor, title, onClick }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="interactive-chip"
      style={{
        ...sx.mono8,
        color,
        border: `1px solid ${borderColor}`,
        padding: "2px 6px",
        background,
        cursor: "pointer",
        textTransform: "lowercase",
        borderRadius: 0,
      }}
    >
      {children}
    </button>
  );
}

function SourceStrip({ diagnostics = {}, onBadgeClick }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
      {Object.entries(diagnostics).map(([name, diag]) => (
        <ClickBadge
          key={name}
          onClick={() => onBadgeClick?.(name, diag)}
          title={diag.detail}
          color={diag.ok ? tones.ok : tones.error}
          borderColor={diag.ok ? `${tones.ok}44` : `${tones.error}44`}
          background={diag.ok ? `${tones.ok}0C` : `${tones.error}0C`}
        >
          {name}
        </ClickBadge>
      ))}
    </div>
  );
}

function LoadingShell({ error }) {
  return (
    <div style={{ minHeight: "100vh", background: "#0A0806", color: tones.text, padding: 32, fontFamily: MONO }}>
      <div>{error ? `collector unavailable: ${error}` : "collecting live state..."}</div>
    </div>
  );
}

function StatusBanner({ error, stale, diagnostics, status }) {
  const failedSources = Object.values(diagnostics || {}).filter((diag) => diag && !diag.ok).length;
  const degraded = Boolean(error) || Boolean(stale) || failedSources > 0 || (status?.consecutiveFailures || 0) > 0;
  if (!degraded) {
    return null;
  }

  let color = tones.warn;
  let text = "degraded observation surface";
  if (error) {
    color = tones.error;
    text = `fetch error: ${error}`;
  } else if (stale) {
    color = tones.error;
    text = "snapshot stale";
  } else if ((status?.consecutiveFailures || 0) > 0) {
    color = tones.error;
    text = `collector failures: ${status.consecutiveFailures}`;
  } else if (failedSources > 0) {
    text = `${failedSources} source probe(s) failing`;
  }

  return (
    <div style={{ marginBottom: 18, border: `1px solid ${color}44`, background: `${color}10`, color, padding: "10px 12px", ...sx.mono11 }}>
      {text}
    </div>
  );
}

function InfoPanel({ title, children }) {
  return (
    <div style={{ ...sx.panel, marginTop: 12, padding: "10px 12px", color: tones.dim, ...sx.mono9, lineHeight: 1.7 }}>
      <div style={{ color: tones.accent, marginBottom: 4 }}> {title}</div>
      {children}
    </div>
  );
}

function AvailableSurface({ tmux, diagnostics, siblings }) {
  const siblingMap = Object.fromEntries((siblings || []).map((item) => [item.id, item]));
  const agentyAvailable = diagnostics?.tmux?.ok;
  return (
    <InfoPanel title="AVAILABLE SURFACE">
      <div>{`agenty: ${agentyAvailable ? "indirect only via tmux/status.log" : "not currently observable"}`}</div>
      <div>{`tmux panes: ${tmux?.panes?.length || 0}, agenty utc warnings: ${tmux?.utcWarnings ?? "n/a"}`}</div>
      <div>{`tmuxdesk adapter: ${siblingMap.tmuxdesk?.status || "absent"}`}</div>
      <div>{`corpora adapter: ${siblingMap.corpora?.status || "absent"}`}</div>
      <div>quota histories / token usage: not yet wired to a stable agenty source</div>
    </InfoPanel>
  );
}

function DiagnosticDetail({ selectedDiagnostic }) {
  if (!selectedDiagnostic) {
    return null;
  }

  return (
    <div style={{ ...sx.panel, marginTop: 10, padding: "8px 10px", color: tones.dim, ...sx.mono9, lineHeight: 1.6 }}>
      <span style={{ color: selectedDiagnostic.diag?.ok ? tones.ok : tones.error }}>{selectedDiagnostic.name}</span>
      {" · "}
      {selectedDiagnostic.diag?.detail || "no detail"}
      {selectedDiagnostic.diag?.checkedAt ? ` · checked ${selectedDiagnostic.diag.checkedAt}` : ""}
    </div>
  );
}

function SummaryTile({ label, value, detail, tone = tones.accent, onClick }) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className={onClick ? "interactive-card summary-card" : "summary-card"}
      style={{
        minWidth: 132,
        padding: "10px 12px",
        border: `1px solid ${tone}22`,
        background: tones.panel,
        textAlign: "left",
        cursor: onClick ? "pointer" : "default",
      }}
    >
      <div style={{ ...sx.mono8, color: "#7D694B", marginBottom: 5 }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 15, color: tone, marginBottom: 4 }}>{value}</div>
      <div style={{ ...sx.display12, color: "#A39277" }}>{detail}</div>
    </Comp>
  );
}

function InsightCard({ title, answer, detail, tone = tones.calm, onClick }) {
  return (
    <button
      onClick={onClick}
      className="interactive-card insight-card"
      style={{
        flex: "1 1 220px",
        minWidth: 220,
        padding: "12px 14px",
        border: `1px solid ${tone}22`,
        background: "#0D0B08",
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      <div style={{ ...sx.mono8, color: "#7D694B", marginBottom: 6 }}>{title}</div>
      <div style={{ ...sx.mono11, color: tone, marginBottom: 6 }}>{answer}</div>
      <div style={{ ...sx.display12, color: "#A39277", lineHeight: 1.35 }}>{detail}</div>
    </button>
  );
}

function SectionCluster({ title, subtitle, children }) {
  return (
    <section style={{ marginTop: 26 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ ...sx.mono10, color: "#9B8767", letterSpacing: "0.18em" }}>{title}</div>
        <div style={{ ...sx.display13, fontStyle: "italic", marginTop: 2 }}>{subtitle}</div>
      </div>
      <div>{children}</div>
    </section>
  );
}

function QuickJumpBar({ sections, onJump }) {
  return (
    <div className="section-jump-bar">
      {sections.map((section) => (
        <button key={section.id} className="section-jump-button" onClick={() => onJump(section.id)}>
          <span className="section-jump-label">{section.label.replace(/^[IVX]+\.\s*/, "")}</span>
          <span className="section-jump-status" style={{ color: section.statusColor }}>
            {section.status}
          </span>
        </button>
      ))}
    </div>
  );
}

function FooterLink({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: "#8D7450", textDecoration: "none", borderBottom: "1px solid #3A2B1A" }}>
      {children}
    </a>
  );
}

function toggleInSet(setter, value) {
  setter((prev) => {
    const next = new Set(prev);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    return next;
  });
}

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [openSections, setOpenSections] = useState(new Set(["host", "verdict"]));
  const [selectedDiagnostic, setSelectedDiagnostic] = useState(null);
  const revisionRef = useRef(0);
  const deferredData = useDeferredValue(data);
  const sectionRefs = useRef({});

  useEffect(() => {
    if (USE_MOCK) {
      setData(buildMockState());
      const interval = setInterval(() => {
        setData((prev) => evolveMockState(prev || buildMockState()));
      }, 5000);
      return () => clearInterval(interval);
    }

    let active = true;
    let controller = null;

    async function fetchState() {
      try {
        controller?.abort();
        controller = new AbortController();
        const response = await fetch("/api/state", { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json();
        if (!active) {
          return;
        }
        if ((payload.revision || 0) === revisionRef.current) {
          setError("");
          return;
        }
        revisionRef.current = payload.revision || 0;
        startTransition(() => {
          setData(payload);
          setError("");
        });
      } catch (err) {
        if (err.name === "AbortError") {
          return;
        }
        if (active) {
          setError(err.message);
        }
      }
    }

    fetchState();
    const interval = setInterval(fetchState, 5000);
    return () => {
      active = false;
      controller?.abort();
      clearInterval(interval);
    };
  }, []);

  const globalLoad = useMemo(() => {
    if (!data?.sections?.length) {
      return 0;
    }
    return data.sections.reduce((sum, section) => sum + (section.attention || 0), 0) / data.sections.length;
  }, [data]);

  if (!data) {
    return <LoadingShell error={error} />;
  }

  const safeData = deferredData || data;
  const sections = safeData.sections || [];
  const diagnostics = safeData.diagnostics || {};
  const histories = safeData.histories || {};
  const traces = safeData.traces || [];
  const events = safeData.events || [];
  const tmux = safeData.tmux || {};
  const siblings = safeData.siblings || [];
  const status = safeData.status || {};
  const collector = safeData.collector || {};
  const host = safeData.host || { hostname: "unknown" };
  const ingress = safeData.ingress || {};
  const deployment = safeData.deployment || {};
  const sectionMap = Object.fromEntries(sections.map((section) => [section.id, section]));
  const primarySections = PRIMARY_SECTION_ORDER.map((id) => sectionMap[id]).filter(Boolean);
  const contextSections = CONTEXT_SECTION_ORDER.map((id) => sectionMap[id]).filter(Boolean);
  const remainingSections = sections.filter((section) => ![...PRIMARY_SECTION_ORDER, ...CONTEXT_SECTION_ORDER].includes(section.id));
  const globalHistory = Object.values(histories).flat().slice(-30);
  const isStale =
    typeof data.stalenessMs === "number" &&
    typeof data.meta?.staleAfterMs === "number" &&
    data.stalenessMs > data.meta.staleAfterMs;
  const dirtyRepoCount = safeData.repos?.filter((repo) => repo.dirty > 0).length || 0;
  const activePaneCount = tmux?.panes?.filter((pane) => pane.command !== "bash").length || 0;
  const failedProbeCount = Object.values(diagnostics).filter((diag) => diag && !diag.ok).length;
  const listeners = safeData.ports?.filter((entry) => ![22, 53, 2019, 4369].includes(entry.port)).length || 0;

  function focusSection(sectionId) {
    setOpenSections((prev) => new Set(prev).add(sectionId));
    requestAnimationFrame(() => {
      sectionRefs.current[sectionId]?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function handleDiagnosticClick(name, diag) {
    setSelectedDiagnostic({ name, diag });
    const sectionId = DIAGNOSTIC_SECTION_MAP[name];
    if (sectionId) {
      focusSection(sectionId);
    }
  }

  const deploymentAnswers = [
    {
      title: "SERVER-STATE-REPORT PUBLIC",
      answer: deployment.serverStateReportAnswer || (listeners ? "reachable on local listener" : "not yet confirmed"),
      detail: deployment.serverStateReportDetail || "Public routing truth has not been derived yet.",
      tone: toneFor(Boolean(deployment.serverStateReportOk), tones.ok, tones.warn),
      target: deployment.serverStateReportSection || "ports",
    },
    {
      title: "PROXY POSTURE",
      answer: deployment.proxyAnswer || "ingress not yet derived",
      detail: deployment.proxyDetail || "Caddy / nginx coordination surface not yet computed.",
      tone: toneFor(Boolean(deployment.proxyOk), tones.calm, tones.warn),
      target: "ingress",
    },
    {
      title: "SUBDOMAIN READINESS",
      answer: deployment.subdomainAnswer || "readiness not yet derived",
      detail: deployment.subdomainDetail || "No deployment matrix yet.",
      tone: toneFor(Boolean(deployment.subdomainOk), tones.ok, tones.warn),
      target: "deployment",
    },
  ];

  return (
    <>
      <style>{`
        @keyframes agentPulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1.2); }
        }
        @keyframes alertFlash {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>

      <div style={sx.shell}>
        <TraceWaterfall traces={traces} />

        <div style={sx.page} className="app-page">
          <StatusBanner error={error} stale={isStale} diagnostics={diagnostics} status={status} />

          <div style={{ marginBottom: 28, borderBottom: "1px solid #221A12", paddingBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
              <div style={{ flex: "1 1 560px" }}>
                <div style={{ fontFamily: DISPLAY, fontSize: 10, letterSpacing: "0.35em", color: "#6A5A40", textTransform: "uppercase", marginBottom: 5 }}>
                  dev · state · observation surface
                </div>
                <h1 style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, letterSpacing: "0.04em", color: tones.text, lineHeight: 1.1 }}>
                  WORKSTATE // WHAT SHOULD WORK
                </h1>
                <div style={{ fontFamily: DISPLAY, fontSize: 12, color: "#605038CC", fontStyle: "italic", marginTop: 4 }}>
                  one machine, observed directly · everything else explains the machine
                </div>

                <SourceStrip diagnostics={diagnostics} onBadgeClick={handleDiagnosticClick} />
                <DiagnosticDetail selectedDiagnostic={selectedDiagnostic} />
                <AvailableSurface tmux={tmux} diagnostics={diagnostics} siblings={siblings} />

                <div className="summary-grid" style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 14 }}>
                  <SummaryTile label="load" value={host.load ? host.load[0].toFixed(2) : "--"} detail="1-minute load average" tone={isStale ? tones.warn : tones.ok} onClick={() => focusSection("host")} />
                  <SummaryTile label="listeners" value={String(listeners)} detail="public / app-facing sockets" tone={tones.calm} onClick={() => focusSection("ports")} />
                  <SummaryTile label="active panes" value={String(activePaneCount)} detail="non-bash tmux panes" tone="#AF52DE" onClick={() => focusSection("tmux")} />
                  <SummaryTile label="dirty repos" value={String(dirtyRepoCount)} detail="manual merge candidates" tone={dirtyRepoCount ? tones.warn : tones.ok} onClick={() => focusSection("repos")} />
                  <SummaryTile label="failing probes" value={String(failedProbeCount)} detail="collector/source degradation" tone={failedProbeCount ? tones.error : tones.ok} onClick={() => focusSection("verdict")} />
                </div>

                <div className="insight-grid" style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12 }}>
                  {deploymentAnswers.map((item) => (
                    <InsightCard key={item.title} title={item.title} answer={item.answer} detail={item.detail} tone={item.tone} onClick={() => focusSection(item.target)} />
                  ))}
                </div>
              </div>

              <div style={{ ...sx.mono9, color: "#504030", textAlign: "right", lineHeight: 1.7, minWidth: 220 }}>
                <div style={{ color: "#C8A040CC", letterSpacing: 0.8 }}>{host.hostname} · live host</div>
                <div>{`${ingress.publicUrl || "port 8091"} -> observation surface`}</div>
                <div>{`collected ${safeData.collectedAt || "unknown"}`}</div>
                <div style={{ color: isStale ? tones.error : "#504030" }}>{`staleness ${data.stalenessMs} ms`}</div>
                <div>{`collector ${status.ready ? "ready" : "unknown"} / ${status.healthy ? "healthy" : "degraded"}`}</div>
                <div style={{ marginTop: 4 }}>
                  <span style={{ color: tones.accent }}>{Math.round(globalLoad * 100)}% global</span>{" "}
                  <AgentPulse value={globalLoad} color={tones.accent} history={globalHistory} />
                </div>
              </div>
            </div>

            <div style={{ height: 2.5, background: "#14100C", borderRadius: 1, overflow: "hidden", marginTop: 16 }}>
              <div
                style={{
                  height: "100%",
                  width: `${globalLoad * 100}%`,
                  background: globalLoad > 0.75 ? "linear-gradient(90deg, #FF3B30, #FF9500)" : "linear-gradient(90deg, #34C759, #30D5C8)",
                  transition: "width 0.4s ease, background 0.6s ease",
                }}
              />
            </div>
          </div>

          <QuickJumpBar sections={[...primarySections, ...contextSections]} onJump={focusSection} />

          <SectionCluster title="SERVER STATE" subtitle="Primary machine truth: capacity, listeners, ingress posture, services, and whether the observation surface is trustworthy.">
            {primarySections.map((section, index) => (
              <div
                key={section.id}
                ref={(node) => {
                  sectionRefs.current[section.id] = node;
                }}
              >
                <AccordionSection
                  section={section}
                  color={RAINBOW[index % RAINBOW.length]}
                  isOpen={openSections.has(section.id)}
                  onToggle={() => toggleInSet(setOpenSections, section.id)}
                  history={histories[section.id] || []}
                />
              </div>
            ))}
          </SectionCluster>

          <SectionCluster title="EXPLANATORY LAYERS" subtitle="Subordinate surfaces that explain why the server feels busy, stuck, noisy, or in motion.">
            {[...contextSections, ...remainingSections].map((section, index) => (
              <div
                key={section.id}
                ref={(node) => {
                  sectionRefs.current[section.id] = node;
                }}
              >
                <AccordionSection
                  section={section}
                  color={RAINBOW[(index + primarySections.length) % RAINBOW.length]}
                  isOpen={openSections.has(section.id)}
                  onToggle={() => toggleInSet(setOpenSections, section.id)}
                  history={histories[section.id] || []}
                />
              </div>
            ))}
          </SectionCluster>

          <div style={{ marginTop: 24, borderTop: "1px solid #16120C", paddingTop: 12, ...sx.mono9, color: "#352818" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              <span>
                EVENT BUS ▶{" "}
                {events[0] ? (
                  <span style={{ color: events[0].color, animation: "alertFlash 1.2s ease-in-out infinite" }}>{events[0].msg}</span>
                ) : (
                  <span style={{ color: "#2A2018" }}>idle</span>
                )}
              </span>
              <span style={{ color: error || isStale ? tones.error : "#3A2818" }}>
                {error ? `fetch error: ${error}` : isStale ? "snapshot stale" : `collector started ${formatTimestamp(collector.startedAt)}`}
              </span>
            </div>
            <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              <span style={{ color: "#4B3A26" }}>public source</span>
              <FooterLink href={GITHUB_URL}>github.com/uprootiny/server-state-report</FooterLink>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
