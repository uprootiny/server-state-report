export function summarizePorts(ports, collectedAt, ctx) {
  const { clamp, measuredItem, makeItem, runbook } = ctx;
  const publicPorts = ports.filter((entry) => ![22, 53, 2019, 4369].includes(entry.port));
  const httpPorts = publicPorts.filter((entry) => entry.http);
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
                const detail = entry.http
                  ? `${entry.http.headline}${Number.isFinite(entry.http.latencyMs) ? ` · ${entry.http.latencyMs}ms` : ""}`
                  : null;
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
                detail: entry.http
                  ? `${entry.http.headline}${Number.isFinite(entry.http.latencyMs) ? ` · ${entry.http.latencyMs}ms` : ""}`
                  : null,
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
      runbook("Port Ownership", ["ss -ltnp", "readlink -f /proc/<pid>/cwd"]),
    ],
  };
}

export function summarizeIngress(ingress, ports, collectedAt, ctx) {
  const { clamp, measuredItem, runbook, paths } = ctx;
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
            `Caddy: ${ingress.caddy?.running ? "running" : ingress.caddy?.enabled ? "enabled but inactive" : "inactive"}${
              ingress.caddy?.configPresent ? ` @ ${ingress.caddy.configPath}` : ""
            }`,
            "systemctl is-active/is-enabled caddy",
            collectedAt
          ),
          measuredItem(
            `nginx: ${ingress.nginx?.running ? "running" : ingress.nginx?.enabled ? "enabled but inactive" : "inactive"}${
              ingress.nginx?.configPresent ? " with config present" : ""
            }`,
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
        `sed -n '1,220p' ${paths.caddyfile}`,
        `ss -ltnp | rg ':(80|443|8091|8090|7391|8751|8901|17888|31823)'`,
      ]),
      runbook("Virtual Host Audit", [`ls -la ${paths.nginxSitesEnabled}`, `ls -la ${paths.nginxConfD}`]),
    ],
  };
}

export function summarizeHost(host, topProcesses, collectedAt, ctx) {
  const { clamp, formatBytes, formatDuration, measuredItem, makeItem, runbook } = ctx;
  const memoryRatio = 1 - host.mem.available / host.mem.total;
  const pressure = clamp(memoryRatio * 0.45 + (host.load[0] / 4) * 0.35 + host.disk.usePct * 0.2);
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

export function summarizeServices(services, ports, collectedAt, ctx) {
  const { clamp, measuredItem, derivedItem, runbook } = ctx;
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

export function summarizeTmux(tmux, collectedAt, ctx) {
  const { clamp, measuredItem, derivedItem, runbook, paths } = ctx;
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
              .map((pane) => measuredItem(`${pane.session}:${pane.pane} ${pane.command} @ ${pane.currentPath}`, "tmux list-panes -a", collectedAt))
          : [measuredItem("No non-bash panes observed", "tmux list-panes -a", collectedAt)],
      },
      {
        heading: "B. Observation hazards",
        items: [
          measuredItem(
            `agenty status log datetime.utcnow warnings: ${tmux.utcWarnings}`,
            `rg 'datetime.utcnow' ${paths.agentyStatusLog}`,
            collectedAt
          ),
          ...(tmux.recentLogs.length
            ? tmux.recentLogs.map((entry) => measuredItem(`recent log: ${entry}`, `ls -lt ${paths.tmuxLogDir}`, collectedAt))
            : [measuredItem("No tmux logs found", `ls -lt ${paths.tmuxLogDir}`, collectedAt)]),
        ].slice(0, 6),
      },
    ],
    subrubrics: [
      runbook("Pane Census", [
        "tmux list-panes -a -F '#S:#I.#P #{pane_current_command} #{pane_current_path}'",
        "tmux list-windows -a",
      ]),
      runbook("Log Spot Check", [`ls -lt ${paths.tmuxLogDir} | head -n 10`, `tail -n 40 ${paths.agentyStatusLog}`]),
    ],
  };
}

export function summarizeRepos(repos, collectedAt, reposSampledAt, ctx) {
  const { clamp, measuredItem, runbook } = ctx;
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

export function summarizeVerdict(hostSection, portsSection, servicesSection, tmuxSection, reposSection, diagnostics, collectedAt, ctx) {
  const { clamp, measuredItem, derivedItem, staleAfterMs, collectorLastCollectedAt, runbook } = ctx;
  const failedSources = Object.values(diagnostics).filter((entry) => !entry.ok).length;
  const stalenessMs = Date.now() - Date.parse(collectedAt);
  const stale = stalenessMs > staleAfterMs;
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
          measuredItem(`Collector freshness: ${collectorLastCollectedAt || "never"}`, "collectorStatusSummary()", collectedAt),
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
      runbook("Collector Logs", ["ps -ef | rg 'node server.mjs'", "ss -ltnp | rg 8091"]),
    ],
  };
}

export function summarizeSiblings(adapters, collectedAt, ctx) {
  const { clamp, measuredItem, derivedItem } = ctx;
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

export function summarizeEntityModel(entityStore, collectedAt, ctx) {
  const { clamp, derivedItem, runbook } = ctx;
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
