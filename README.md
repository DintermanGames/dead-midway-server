# dead-midway-server

Tiny zero-dependency Node.js WebSocket relay for **Dead Midway** online co-op / PvP (rooms of 2-4 players; the host's game runs the simulation, the server only relays messages).

Run: `node server.mjs` (Node 18+)

Environment variables:
- `PORT` - listen port (Render sets this)
- `STATIC_DIR` - set to `none` for relay-only
- `ALLOWED_ORIGINS` - comma list of web origins allowed to connect (`https://localhost` = the Android app)
- `MAX_CLIENTS` (default 400), `MAX_ROOMS` (default 150)

Health check: `/healthz` - WebSocket endpoint: `/ws`
