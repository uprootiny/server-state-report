import { useEffect, useMemo, useRef, useState } from "react";

const RAINBOW = ["#FF3B30", "#FF9500", "#FFD60A", "#34C759", "#30D5C8", "#007AFF", "#AF52DE", "#FF2D92"];
const GITHUB_URL = "https://github.com/uprootiny/server-state-report";

function Sparkline({ data, color, width = 84, height = 22 }) {
  if (!data || data.length < 2) {
    return <span style={{ color, fontSize: 9 }}>--</span>;
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
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color, letterSpacing: 1 }}>
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

function TraceWaterfall({ traces = [] }) {
  const colors = { error: "#FF3B30", warn: "#FF9500", info: "#8A816F", ok: "#34C759" };
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
        background: "linear-gradient(0deg, #0a0806ee 0%, transparent 100%)",
      }}
    >
      <div style={{ position: "absolute", bottom: 4, left: 12, right: 12, display: "flex", flexDirection: "column-reverse" }}>
        {traces.slice(0, 6).map((trace, index) => (
          <div
            key={`${trace.seq}-${trace.ts}`}
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 9,
              color: colors[trace.severity] || "#777",
              opacity: 0.32 + (1 - index / 6) * 0.68,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              letterSpacing: "0.05em",
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
}

function AccordionSection({ section, color, isOpen, onToggle, history }) {
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
        border: `1px solid ${color}1a`,
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
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5, fontWeight: 700, color, letterSpacing: "0.12em" }}>
            {section.label}
          </span>
          <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 11.5, color: `${color}88`, fontStyle: "italic" }}>
            {section.sublabel}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {isBottleneck && (
            <span
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 8,
                color: "#FF3B30",
                border: "1px solid #FF3B3044",
                padding: "1px 5px",
                letterSpacing: "0.15em",
                background: "#FF3B3008",
              }}
            >
              BOTTLENECK
            </span>
          )}
          <span
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 9,
              color: section.statusColor,
              border: `1px solid ${section.statusColor}44`,
              padding: "2px 6px",
              letterSpacing: "0.12em",
              background: `${section.statusColor}0c`,
            }}
          >
            {section.status}
          </span>
          <AgentPulse value={avg} color={color} history={history} />
          <span style={{ color, fontSize: 14, transform: isOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.3s ease" }}>
            ▶
          </span>
        </div>
      </button>

      <div style={{ height, overflow: "hidden", transition: "height 0.35s cubic-bezier(0.4,0,0.2,1)" }}>
        <div ref={contentRef} style={{ padding: "0 18px 16px 18px" }}>
          <p
            style={{
              fontFamily: "'Cormorant Garamond', serif",
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

          {history?.length > 1 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, color: "#555", letterSpacing: 1 }}>
                  ATTENTION HISTORY
                </span>
                <svg width={140} height={18} style={{ flexShrink: 0 }}>
                  {history.map((value, index) => {
                    const x = (index / history.length) * 138;
                    const barHeight = Math.max(1, value * 16);
                    const hueIndex = Math.floor(value * (RAINBOW.length - 1));
                    return <rect key={index} x={x} y={18 - barHeight} width={3} height={barHeight} fill={`${RAINBOW[hueIndex]}44`} rx={1} />;
                  })}
                </svg>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, color }}>
                  p95 {(Math.max(...history) * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          )}

          {section.groups.map((group) => (
            <div key={group.heading} style={{ marginBottom: 12 }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color, letterSpacing: "0.08em", marginBottom: 5, opacity: 0.8 }}>
                {group.heading}
              </div>
              <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {group.items.map((item, index) => (
                  <li
                    key={`${group.heading}-${index}`}
                    style={{
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: 10.5,
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
          ))}
        </div>
      </div>
    </div>
  );
}

function SourceStrip({ diagnostics = {} }) {
  const entries = Object.entries(diagnostics);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
      {entries.map(([name, diag]) => (
        <span
          key={name}
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 8,
            color: diag.ok ? "#34C759" : "#FF3B30",
            border: `1px solid ${diag.ok ? "#34C75944" : "#FF3B3044"}`,
            padding: "2px 6px",
            letterSpacing: "0.12em",
            background: diag.ok ? "#34C7590c" : "#FF3B300c",
          }}
          title={diag.detail}
        >
          {name}
        </span>
      ))}
    </div>
  );
}

function LoadingShell({ error }) {
  return (
    <div style={{ minHeight: "100vh", background: "#0A0806", color: "#D4C8B0", padding: 32, fontFamily: "'IBM Plex Mono', monospace" }}>
      <div>{error ? `collector unavailable: ${error}` : "collecting live state..."}</div>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [openSections, setOpenSections] = useState(new Set(["host", "verdict"]));

  useEffect(() => {
    let active = true;

    async function fetchState() {
      try {
        const response = await fetch("/api/state", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json();
        if (active) {
          setData(payload);
          setError("");
        }
      } catch (err) {
        if (active) {
          setError(err.message);
        }
      }
    }

    fetchState();
    const interval = setInterval(fetchState, 5000);
    return () => {
      active = false;
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

  const globalHistory = Object.values(data.histories || {}).flat().slice(-30);

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

      <div
        style={{
          minHeight: "100vh",
          background: "radial-gradient(ellipse at 25% 5%, #141008 0%, #0A0806 55%, #060405 100%)",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <TraceWaterfall traces={data.traces} />

        <div style={{ position: "relative", zIndex: 2, maxWidth: 880, margin: "0 auto", padding: "32px 20px 120px" }}>
          <div style={{ marginBottom: 28, borderBottom: "1px solid #221A12", paddingBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
              <div>
                <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 10, letterSpacing: "0.35em", color: "#6A5A40", textTransform: "uppercase", marginBottom: 5 }}>
                  dev · state · observation surface
                </div>
                <h1 style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 22, fontWeight: 700, letterSpacing: "0.04em", color: "#D4C8B0", lineHeight: 1.1 }}>
                  WORKSTATE // WHAT SHOULD WORK
                </h1>
                <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 12, color: "#605038CC", fontStyle: "italic", marginTop: 4 }}>
                  collector-backed · source-validated · loopback-probed
                </div>
                <SourceStrip diagnostics={data.diagnostics} />
              </div>

              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#504030", textAlign: "right", lineHeight: 1.7 }}>
                <div style={{ color: "#C8A040CC", letterSpacing: 0.8 }}>{data.host.hostname} · {data.host ? "live host" : "unknown"}</div>
                <div>{"8091 -> observation surface"}</div>
                <div>{`collected ${data.collectedAt}`}</div>
                <div>{`staleness ${data.stalenessMs} ms`}</div>
                <div style={{ marginTop: 4 }}>
                  <span style={{ color: "#D4A844" }}>{Math.round(globalLoad * 100)}% global</span>{" "}
                  <AgentPulse value={globalLoad} color="#D4A844" history={globalHistory} />
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

          {data.sections.map((section, index) => (
            <AccordionSection
              key={section.id}
              section={section}
              color={RAINBOW[index % RAINBOW.length]}
              isOpen={openSections.has(section.id)}
              onToggle={() =>
                setOpenSections((prev) => {
                  const next = new Set(prev);
                  if (next.has(section.id)) {
                    next.delete(section.id);
                  } else {
                    next.add(section.id);
                  }
                  return next;
                })
              }
              history={data.histories?.[section.id] || []}
            />
          ))}

          <div style={{ marginTop: 24, borderTop: "1px solid #16120C", paddingTop: 12, fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#352818", letterSpacing: 0.8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              <span>
                EVENT BUS ▶{" "}
                {data.events?.[0] ? (
                  <span style={{ color: data.events[0].color, animation: "alertFlash 1.2s ease-in-out infinite" }}>
                    {data.events[0].msg}
                  </span>
                ) : (
                  <span style={{ color: "#2A2018" }}>idle</span>
                )}
              </span>
              <span style={{ color: error ? "#FF3B30" : "#3A2818" }}>
                {error ? `fetch error: ${error}` : `collector started ${data.collector.startedAt}`}
              </span>
            </div>
            <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              <span style={{ color: "#4B3A26" }}>public source</span>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                style={{ color: "#8D7450", textDecoration: "none", borderBottom: "1px solid #3A2B1A" }}
              >
                github.com/uprootiny/server-state-report
              </a>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
