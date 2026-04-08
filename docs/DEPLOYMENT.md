# Deployment

## Minimal deployment

```bash
git clone https://github.com/uprootiny/server-state-report.git
cd server-state-report
npm install
npm run build
npm run serve
```

This serves:

- static assets from `dist/`
- live JSON from `/api/state`

Default port: `8091`

## systemd user service

Example unit:

```ini
[Unit]
Description=server-state-report
After=network.target

[Service]
WorkingDirectory=/home/USER/server-state-report
ExecStart=/usr/bin/env npm run serve
Restart=always
RestartSec=3
Environment=PORT=8091

[Install]
WantedBy=default.target
```

Install:

```bash
mkdir -p ~/.config/systemd/user
cp server-state-report.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now server-state-report.service
```

## Caddy

Example reverse proxy:

```caddy
observe.example.com {
  reverse_proxy 127.0.0.1:8091
}
```

## Notes

- Keep the app on localhost behind a reverse proxy when possible.
- The collector runs host commands, so deploy it on a machine where those probes are permitted.
- If tmux, systemd user units, or git repos are absent, those probes degrade cleanly rather than crashing the app.
