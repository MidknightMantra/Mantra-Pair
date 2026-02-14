# Mantra-Pair (Railway)

Pairing web UI + API for generating a WhatsApp session via Baileys and delivering it to your own WhatsApp chat.

## Endpoints

- `POST /pair`
  - Body: `{ "method": "code", "phone": "2547..." }` or `{ "method": "qr" }`
  - Returns: `{ success, id, method }`
- `GET /pair/events/:id` (SSE)
  - Streams `status`, `code`, `qr`, `exported`, `error` events
- `POST /auth`
  - Body: `{ "apiKey": "..." }`
  - Sets an HttpOnly cookie so the browser can authenticate `EventSource` (SSE)
- `GET /health`

## Railway Environment Variables

Recommended:

- `NODE_ENV=production`
- `CORS_ORIGINS=https://your-domain` (comma-separated, required to enable CORS for browsers with an Origin header)

Tuning:

- `RATE_LIMIT_WINDOW_MS=60000`
- `RATE_LIMIT_MAX=30`
- `SESSION_TTL_MS=300000`
- `SESSION_IDLE_TTL_MS=120000`
- `MAX_RETRIES=3`
- `RETRY_DELAY_MS=5000`

Session export:

- Always sends `Mantra~<base64>` (no server-side secret required)

## Notes

- The server sends the session token(s) to the paired WhatsApp account (your own chat) after connect.
- This build has no API-key gate. If you host it publicly, expect abuse unless you add protection.
