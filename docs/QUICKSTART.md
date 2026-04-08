# Quickstart

## Fast path

```bash
git clone https://github.com/uprootiny/server-state-report.git
cd server-state-report
npm install
npm run build
npm run serve
```

Open:

- `http://localhost:8091`
- `http://<server-ip>:8091`

## What it needs on the host

The collector assumes these commands exist:

- `bash`
- `ps`
- `ss`
- `df`
- `free`
- `systemctl`
- `tmux`
- `git`
- `curl`

If one of those is missing, the UI still loads, but the matching source strip badge will turn red and the failed probe will appear in the observation surface.

## Development loop

Terminal 1:

```bash
npm install
npm run dev
```

Terminal 2:

```bash
npm run build
npm run serve
```

Use `npm run dev` for frontend iteration and `npm run serve` when you want the collector-backed app shell.

## Clean reuse on another server

1. Clone the repo.
2. Run `npm install`.
3. Run `npm run build`.
4. Run `npm run serve`.
5. Put it behind Caddy, nginx, or systemd if you want persistence.

Nothing in the code is hard-bound to the original machine except the breadth of what the host actually exposes.
