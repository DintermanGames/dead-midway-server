# dead-midway-server (v0.8.0)

Small Node.js server for **Dead Midway**:
- WebSocket relay for online co-op / PvP rooms (2-4 players; the host's game runs the simulation) and **Quick Match** (random-player queue). Invite codes work as before, and v0.7.x clients keep working.
- HTTP API under `/api/v1`: guest accounts + recovery codes, cloud saves (revision checked, `409` on conflict), Daily/Weekly Challenge leaderboards, self-hosted anonymous analytics and an admin summary.

Run: `node server.mjs` (Node 18+). The only dependency, `pg`, is committed in `node_modules/` because the Render service has no build step.

Environment variables:
- `PORT` - listen port (Render sets this)
- `STATIC_DIR` - set to `none` for relay/API only
- `ALLOWED_ORIGINS` - comma list of web origins allowed to connect (`https://localhost` = the Android app)
- `MAX_CLIENTS` (default 400), `MAX_ROOMS` (default 150)
- `DATABASE_URL` - Postgres connection string (Render: the database's **Internal Database URL**). Unset = in-memory store (lost on restart/sleep; clients re-upload their saves automatically). If set but unreachable, the server falls back to memory and `/healthz` shows `store: "memory (postgres unavailable)"`.
- `DATA_DIR` - optional folder for a JSON snapshot of the in-memory store (only useful with a persistent disk)
- `ADMIN_KEY` - enables `GET /api/v1/analytics/summary` and `POST /api/v1/admin/delete` (header `X-Admin-Key`). Unset = those return 404.
- `API_RATE_PER_MIN` (default 600 per IP)

Health check: `/healthz` (shows version, rooms, clients, queue, store) - WebSocket endpoint: `/ws`
