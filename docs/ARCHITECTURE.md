# Architecture

## Design goal

The observation surface should have one source of truth.

That source is the collector in `server.mjs`.

The React app is only a renderer of collected state. It does not invent telemetry, own its own polling graph, or simulate histories.

## Dataflow

```text
host commands / procfs / tmux / git
        ↓
collector loop in server.mjs
        ↓
canonical snapshot + bounded history + trace log
        ↓
/api/state
        ↓
React UI
```

## Why this is structured this way

This keeps the system honest:

- one polling loop instead of many panel-specific loops
- one event log instead of per-widget timers
- one canonical snapshot instead of duplicated local state
- explicit source diagnostics so blind spots are visible

## Collector responsibilities

The collector:

- probes host resources
- enumerates listening ports
- checks loopback HTTP responses for known listeners
- inspects `systemctl --user`
- inspects tmux panes and recent tmux logs
- scans git repos and summarizes drift
- computes derived sections from raw observations
- stores bounded histories and recent traces

## Frontend responsibilities

The frontend:

- fetches `/api/state`
- renders sections, traces, and diagnostics
- never simulates host state
- treats collector freshness and source failures as first-class UI concerns

## Validity model

The report is only as trustworthy as its probes.

That is why each source gets:

- an `ok` bit
- a `detail` string
- a `checkedAt` timestamp

If a probe fails, the UI should still render, but the failure must remain visible.
