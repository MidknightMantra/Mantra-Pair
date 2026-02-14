const crypto = require('crypto');
const { EventEmitter } = require('events');
const path = require('path');

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const fs = require('fs-extra');
const pino = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  DisconnectReason,
  Browsers,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const PORT = Number(process.env.PORT || 3000);
const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info');

// Optional protection: if PAIR_API_KEY is set, /api/pair requires x-api-key,
// and SSE requires the per-session streamKey returned by /api/pair.
const PAIR_API_KEY = String(process.env.PAIR_API_KEY || '').trim();

// Session lifecycle
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 5 * 60_000);
const SESSION_IDLE_TTL_MS = Number(process.env.SESSION_IDLE_TTL_MS || 2 * 60_000);
const SESSION_SWEEP_MS = Number(process.env.SESSION_SWEEP_MS || 30_000);

// Retry behavior for transient WA websocket issues
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 8);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 4_000);
const RETRY_DELAY_MAX_MS = Number(process.env.RETRY_DELAY_MAX_MS || 30_000);

// Rate limit for creating sessions (SSE is intentionally NOT rate-limited)
const PAIR_WINDOW_MS = Number(process.env.PAIR_WINDOW_MS || 60_000);
const PAIR_MAX = Number(process.env.PAIR_MAX || 20);

// Export format: legacy by default.
// If EXPORT_ENCRYPTED=true, SESSION_SECRET is required and we send MantraEnc~...
const EXPORT_ENCRYPTED = String(process.env.EXPORT_ENCRYPTED || 'false').toLowerCase() === 'true';
const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim();
if (EXPORT_ENCRYPTED && !SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required when EXPORT_ENCRYPTED=true');
}

const logger = pino({ level: LOG_LEVEL });

function now() {
  return Date.now();
}

function randomId(prefix) {
  return `${prefix}_${now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function validatePhone(phone) {
  const cleaned = String(phone || '').replace(/\D/g, '');
  if (cleaned.length < 10 || cleaned.length > 15) {
    return { ok: false, error: 'Phone number must be 10-15 digits' };
  }
  return { ok: true, phone: cleaned };
}

function safeSelfJid(sock) {
  const id = String(sock?.user?.id || '');
  const left = id.split('@')[0] || '';
  const number = (left.split(':')[0] || '').trim();
  return number ? `${number}@s.whatsapp.net` : null;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function exportTokensFromCreds(credsBytes) {
  const base64Creds = Buffer.from(credsBytes).toString('base64');

  if (!EXPORT_ENCRYPTED) {
    return [`Mantra~${base64Creds}`];
  }

  const key = crypto.scryptSync(SESSION_SECRET, 'mantra-pair', 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const payload = Buffer.from(JSON.stringify({ v: 1, creds: base64Creds, ts: now() }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [`MantraEnc~${b64url(Buffer.concat([iv, tag, ciphertext]))}`];
}

function requireApiKey(req, res, next) {
  if (!PAIR_API_KEY) return next();
  const key = String(req.get('x-api-key') || '').trim();
  if (key && key === PAIR_API_KEY) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

function isRetryableDisconnectReason(reason) {
  if (reason === undefined || reason === null) return true;
  const retryable = [
    DisconnectReason.connectionClosed,
    DisconnectReason.connectionLost,
    DisconnectReason.timedOut,
    DisconnectReason.restartRequired,
    DisconnectReason.unavailableService,
  ];
  return retryable.includes(reason);
}

function statusCodeFromError(err) {
  return (
    err?.output?.statusCode ??
    err?.data?.statusCode ??
    err?.statusCode ??
    err?.response?.status ??
    undefined
  );
}

// Session store (in-memory). Railway restarts wipe sessions; that is fine for pairing.
// id -> session
const sessions = new Map();

function sessionDir(id) {
  return path.join(__dirname, 'temp', id);
}

async function cleanupSession(s) {
  if (!s) return;
  if (s.timers.ttl) clearTimeout(s.timers.ttl);
  if (s.timers.idle) clearTimeout(s.timers.idle);

  try {
    if (s.sock) await s.sock.end();
  } catch (_) {}

  try {
    await fs.remove(s.dir);
  } catch (_) {}

  sessions.delete(s.id);
}

async function endSocketOnly(s) {
  try {
    if (s.sock) await s.sock.end();
  } catch (_) {}
  s.sock = null;
}

function touchIdle(s) {
  if (s.timers.idle) clearTimeout(s.timers.idle);
  s.timers.idle = setTimeout(() => {
    s.emitter.emit('session_error', { message: 'Session expired due to inactivity.' });
    cleanupSession(s).catch(() => {});
  }, SESSION_IDLE_TTL_MS);
}

function emit(s, event, data) {
  s.lastEventAt = now();
  s.emitter.emit(event, data);
}

async function startPairing(s) {
  await fs.ensureDir(s.dir);
  touchIdle(s);

  const { state, saveCreds } = await useMultiFileAuthState(s.dir);
  let version;
  try {
    if (typeof fetchLatestBaileysVersion === 'function') {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    }
  } catch (e) {
    logger.warn({ err: e }, 'fetchLatestBaileysVersion failed; using default version');
  }

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
    },
    version,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome'),
    printQRInTerminal: false,
    connectTimeoutMs: 90_000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 10_000,
    retryRequestDelayMs: 2_000,
    qrTimeout: 90_000,
    usePairingCode: s.method === 'code',
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async () => undefined,
  });

  s.sock = sock;
  const thisSock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    if (s.sock !== thisSock) return;

    const connection = update.connection;
    const qr = update.qr;
    const lastDisconnect = update.lastDisconnect;

    if (connection) {
      emit(s, 'status', { status: connection });
      touchIdle(s);
    }

    if (qr && s.method === 'qr') {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr);
        s.lastQr = qrDataUrl;
        emit(s, 'qr', { qr: qrDataUrl });
        touchIdle(s);
      } catch (e) {
        emit(s, 'session_error', { message: `Failed to render QR: ${e.message}` });
      }
    }

    if (connection === 'open') {
      s.retries = 0;
      emit(s, 'status', { status: 'connected' });

      await delay(1200);
      const credsPath = path.join(s.dir, 'creds.json');
      if (!fs.existsSync(credsPath)) {
        emit(s, 'session_error', { message: 'creds.json not found after connect' });
        await cleanupSession(s);
        return;
      }

      try {
        const credsBytes = await fs.readFile(credsPath);
        const tokens = exportTokensFromCreds(credsBytes);
        const selfJid = safeSelfJid(sock);
        if (!selfJid) throw new Error('Could not resolve self JID');

        for (const t of tokens) {
          // Send the raw token in a copy-friendly block.
          await sock.sendMessage(selfJid, { text: `\`\`\`\n${t}\n\`\`\`` });
          await delay(300);
        }

        const tokenHint = EXPORT_ENCRYPTED ? 'MantraEnc~...' : 'Mantra~...';
        const pairedAt = new Date().toISOString().replace('T', ' ').replace('Z', ' UTC');

        await sock.sendMessage(selfJid, {
          text:
            '*MANTRA PAIR COMPLETE* ✅\n' +
            `Paired: ${pairedAt}\n\n` +
            '*What you received*\n' +
            `- Session token (starts with ${tokenHint})\n\n` +
            '*Next steps*\n' +
            '1) Copy the token message above\n' +
            '2) Paste it into your bot config as the session value\n' +
            '3) Start/restart the bot\n\n' +
            '*Security*\n' +
            '- Do NOT share this token\n' +
            '- Anyone with it can control this WhatsApp session\n' +
            '- To revoke: WhatsApp -> Linked devices -> Log out\n\n' +
            '_Powered by Mantra Inc_',
        });

        emit(s, 'exported', { format: EXPORT_ENCRYPTED ? 'encrypted' : 'legacy' });
      } catch (e) {
        emit(s, 'session_error', { message: `Failed to export session: ${e.message}` });
      } finally {
        await delay(2500);
        await cleanupSession(s);
      }
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      const message = lastDisconnect?.error?.message || 'Unknown error';

      logger.warn({ id: s.id, reason, message }, 'WA connection closed');
      if (reason === DisconnectReason.loggedOut) {
        emit(s, 'session_error', { message: 'Logged out by WhatsApp. Start pairing again.' });
        await cleanupSession(s);
        return;
      }

      if (isRetryableDisconnectReason(reason) && (s.retries || 0) < MAX_RETRIES) {
        s.retries = (s.retries || 0) + 1;
        emit(s, 'status', { status: 'retrying', retry: s.retries, maxRetries: MAX_RETRIES });
        await endSocketOnly(s);
        const backoff = Math.min(RETRY_DELAY_MAX_MS, RETRY_DELAY_MS * s.retries);
        await delay(backoff);
        if (!sessions.has(s.id)) return;
        startPairing(s).catch((e) => {
          logger.error({ err: e, id: s.id }, 'retry startPairing failed');
          emit(s, 'session_error', { message: 'Retry failed. Try again.' });
          cleanupSession(s).catch(() => {});
        });
        return;
      }

      let msg = `Couldn't login. Connection closed${reason ? ` (code ${reason})` : ''}.`;
      if (reason === DisconnectReason.unavailableService) {
        msg =
          s.method === 'code'
            ? "WhatsApp service is temporarily unavailable for phone-number pairing (503). Try QR, or wait 5-10 minutes and retry."
            : 'WhatsApp service is temporarily unavailable (503). Wait a bit and try again.';
      }

      emit(s, 'session_error', { message: msg });
      await cleanupSession(s);
    }
  });

  if (s.method === 'code') {
    emit(s, 'status', { status: 'requesting_code' });
    await delay(5000);
    if (s.sock !== sock) return;
    try {
      const raw = await sock.requestPairingCode(s.phone);
      const formatted = raw?.match(/.{1,4}/g)?.join('-') || raw;
      s.lastCode = formatted;
      emit(s, 'code', { code: formatted, expiresIn: 60 });
      touchIdle(s);
    } catch (e) {
      const code = statusCodeFromError(e);
      logger.warn({ id: s.id, code, message: e?.message }, 'requestPairingCode failed');

      // If WhatsApp asks us to restart / transient network error, restart the socket flow.
      if (isRetryableDisconnectReason(code) && (s.retries || 0) < MAX_RETRIES) {
        s.retries = (s.retries || 0) + 1;
        emit(s, 'status', { status: 'retrying', retry: s.retries, maxRetries: MAX_RETRIES });
        await endSocketOnly(s);
        const backoff = Math.min(RETRY_DELAY_MAX_MS, RETRY_DELAY_MS * s.retries);
        await delay(backoff);
        if (!sessions.has(s.id)) return;
        startPairing(s).catch((err) => {
          logger.error({ err, id: s.id }, 'retry startPairing failed (after requestPairingCode)');
          emit(s, 'session_error', { message: 'Retry failed. Try QR instead.' });
          cleanupSession(s).catch(() => {});
        });
        return;
      }

      if (code === DisconnectReason.forbidden) {
        emit(s, 'session_error', { message: "Pairing code isn't available right now. Use QR Scan." });
        return;
      }

      emit(s, 'session_error', { message: `Failed to generate pairing code: ${e?.message || 'Unknown error'}` });
    }
  } else {
    emit(s, 'status', { status: 'waiting_qr' });
  }
}

function sweepExpired() {
  const t = now();
  for (const s of sessions.values()) {
    if (t - s.createdAt > SESSION_TTL_MS) {
      s.emitter.emit('session_error', { message: 'Session expired.' });
      cleanupSession(s).catch(() => {});
    }
  }
}

setInterval(sweepExpired, SESSION_SWEEP_MS).unref();

const app = express();

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Railway (and most PaaS) sit behind a reverse proxy and set X-Forwarded-For.
// express-rate-limit expects trust proxy to be enabled in that setup.
const TRUST_PROXY = process.env.TRUST_PROXY;
if (TRUST_PROXY !== undefined && TRUST_PROXY !== '') {
  const n = Number(TRUST_PROXY);
  app.set('trust proxy', Number.isFinite(n) ? n : true);
} else {
  app.set('trust proxy', 1);
}

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), activeSessions: sessions.size });
});

const createLimiter = rateLimit({
  windowMs: PAIR_WINDOW_MS,
  max: PAIR_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Rate limit exceeded. Try again shortly.' },
});

app.post('/api/pair', createLimiter, requireApiKey, async (req, res) => {
  const method = String(req.body?.method || 'code');
  if (!['code', 'qr'].includes(method)) {
    return res.status(400).json({ ok: false, error: 'Invalid method. Use "code" or "qr".' });
  }

  let phone = null;
  if (method === 'code') {
    const v = validatePhone(req.body?.phone);
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
    phone = v.phone;
  }

  const id = randomId('sess');
  const streamKey = crypto.randomBytes(18).toString('hex');

  const s = {
    id,
    streamKey,
    method,
    phone,
    createdAt: now(),
    lastEventAt: now(),
    dir: sessionDir(id),
    emitter: new EventEmitter(),
    sock: null,
    lastQr: null,
    lastCode: null,
    retries: 0,
    timers: { ttl: null, idle: null },
  };

  sessions.set(id, s);
  s.timers.ttl = setTimeout(() => {
    s.emitter.emit('session_error', { message: 'Session expired.' });
    cleanupSession(s).catch(() => {});
  }, SESSION_TTL_MS);

  startPairing(s).catch((e) => {
    logger.error({ err: e, id }, 'startPairing failed');
    s.emitter.emit('session_error', { message: 'Failed to start pairing session.' });
    cleanupSession(s).catch(() => {});
  });

  res.json({
    ok: true,
    id,
    method,
    // Only needed when PAIR_API_KEY is enabled.
    streamKey: PAIR_API_KEY ? streamKey : null,
  });
});

app.get('/api/sessions/:id/events', (req, res) => {
  const id = String(req.params.id || '');
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });

  if (PAIR_API_KEY) {
    const key = String(req.query.key || '').trim();
    if (!key || key !== s.streamKey) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Initial snapshot
  if (s.lastCode) send('code', { code: s.lastCode, expiresIn: 60 });
  if (s.lastQr) send('qr', { qr: s.lastQr });
  send('status', { status: 'listening' });

  const onStatus = (p) => send('status', p);
  const onCode = (p) => send('code', p);
  const onQr = (p) => send('qr', p);
  const onExported = (p) => send('exported', p);
  const onErr = (p) => send('error', p);

  s.emitter.on('status', onStatus);
  s.emitter.on('code', onCode);
  s.emitter.on('qr', onQr);
  s.emitter.on('exported', onExported);
  s.emitter.on('session_error', onErr);

  const keepAlive = setInterval(() => {
    res.write('event: ping\n');
    res.write('data: {}\n\n');
  }, 15_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    s.emitter.off('status', onStatus);
    s.emitter.off('code', onCode);
    s.emitter.off('qr', onQr);
    s.emitter.off('exported', onExported);
    s.emitter.off('session_error', onErr);
  });
});

process.on('SIGINT', async () => {
  logger.warn('Shutting down...');
  for (const s of sessions.values()) {
    // eslint-disable-next-line no-await-in-loop
    await cleanupSession(s).catch(() => {});
  }
  process.exit(0);
});

app.listen(PORT, async () => {
  await fs.ensureDir(path.join(__dirname, 'temp'));
  logger.info({ port: PORT }, 'Mantra-Pair listening');
});
