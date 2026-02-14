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
- `PAIR_API_KEY=...` (required if you want to protect the API)
- `SESSION_SECRET=...` (required in production when encrypted export is enabled)
- `CORS_ORIGINS=https://your-domain` (comma-separated, required to enable CORS for browsers with an Origin header)

Tuning:

- `RATE_LIMIT_WINDOW_MS=60000`
- `RATE_LIMIT_MAX=30`
- `SESSION_TTL_MS=300000`
- `SESSION_IDLE_TTL_MS=120000`
- `MAX_RETRIES=3`
- `RETRY_DELAY_MS=5000`

Session export:

- `EXPORT_ENCRYPTED=true` (default)
- `EXPORT_LEGACY=false` (set true only if you still need the old `Mantra~<base64>` format)

## Decrypting `MantraEnc~...` (for your bot)

This project sends `MantraEnc~...` by default (encrypted).

To get the original `creds.json` bytes back:

```bash
cd /home/Mantra/Mantra-Pair
SESSION_SECRET='your-railway-secret' node scripts/decrypt-session.js 'MantraEnc~...token...' > creds.json
```

## Notes

- The server sends the session token(s) to the paired WhatsApp account (your own chat) after connect.
- If you enable `PAIR_API_KEY`, the UI will ask for an Access Key. The key is stored in an HttpOnly cookie (not visible to JS) for SSE auth.
