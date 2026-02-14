# Mantra-Pair (Railway)

Pairing web UI + API for generating a WhatsApp session via Baileys and delivering it to your own WhatsApp chat.

- `RATE_LIMIT_MAX=30`
- `SESSION_TTL_MS=300000`
- `SESSION_IDLE_TTL_MS=120000`
- `MAX_RETRIES=3`
- `RETRY_DELAY_MS=5000`

Session export:

- Always sends `Mantra~<base64>`

## Notes

- The server sends the session token(s) to the paired WhatsApp account (your own chat) after connect.
- This build has no API-key gate. If you host it publicly, expect abuse unless you add protection.
