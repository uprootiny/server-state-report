# server-state-report

Live observation surface for a Linux host.

Docs:

- [Quickstart](./docs/QUICKSTART.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Deployment](./docs/DEPLOYMENT.md)
- [API](./docs/API.md)

It serves:

- a collector-backed JSON API at `/api/state`
- a React UI that renders the current system state from that API

The collector is the source of truth. It probes:

- host load, memory, disk, top processes
- listening ports and loopback HTTP responses
- running `systemctl --user` services
- tmux panes and recent tmux log files
- repo drift across local git repos

## Run

```bash
npm install
npm run build
npm run serve
```

Default port: `8091`

## API

`GET /api/state`

Returns the current snapshot, bounded history, collector diagnostics, recent trace events, and derived section summaries.

## Clone On Another Server

```bash
git clone https://github.com/uprootiny/server-state-report.git
cd server-state-report
npm install
npm run build
npm run serve
```
