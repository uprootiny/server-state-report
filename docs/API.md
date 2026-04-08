# API

## `GET /api/state`

Returns a single canonical payload for the current observation cycle.

Top-level shape:

```json
{
  "collectedAt": "2026-04-08T08:44:20.000Z",
  "stalenessMs": 1234,
  "host": {},
  "ports": [],
  "services": [],
  "tmux": {},
  "repos": [],
  "diagnostics": {},
  "sections": [],
  "histories": {},
  "traces": [],
  "events": [],
  "collector": {}
}
```

## Semantics

- `diagnostics`: probe health by source
- `sections`: derived summaries rendered by the UI
- `histories`: bounded per-section history arrays
- `traces`: append-only recent change/event log
- `events`: high-signal footer alerts
- `collector`: collector lifecycle info

## Contract

The frontend should prefer `sections` and `diagnostics` for rendering.

If you build another client:

- treat `diagnostics` as first-class data
- do not silently ignore stale snapshots
- do not invent synthetic data when a probe fails
