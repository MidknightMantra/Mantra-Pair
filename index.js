const crypto = require('crypto');
const { EventEmitter } = require('events');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');

const fs = require('fs-extra');
const path = require('path');
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

const app = express();

const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = String(process.env.NODE_ENV || '');

const CORS_ORIGINS = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 30);

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 5 * 60_000);
const SESSION_IDLE_TTL_MS = Number(process.env.SESSION_IDLE_TTL_MS || 2 * 60_000);
const SESSION_CLEANUP_INTERVAL_MS = Number(process.env.SESSION_CLEANUP_INTERVAL_MS || 30_000);

const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 5_000);

const LOG_SESSION_EXPORTS = String(process.env.LOG_SESSION_EXPORTS || 'false').toLowerCase() === 'true';

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '128kb' }));
app.use(express.static('public'));

const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Rate limit exceeded. Try again shortly.' },
});

function log(id, msg, level = 'INFO') {
  const levels = {
    INFO: '\x1b[36m[INFO]\x1b[0m',
    SUCCESS: '\x1b[32m[SUCCESS]\x1b[0m',
    WARNING: '\x1b[33m[WARNING]\x1b[0m',
    ERROR: '\x1b[31m[ERROR]\x1b[0m',
  };
  console.log(`[${new Date().toLocaleTimeString()}] ${levels[level] || levels.INFO} [${id}] ${msg}`);
}

function validatePhone(phone) {
  const cleaned = String(phone || '').replace(/\D/g, '');
  if (cleaned.length < 10 || cleaned.length > 15) {
    return { valid: false, error: 'Phone number must be 10-15 digits' };
  }
  return { valid: true, cleaned };
}

function corsOriginFn(origin, cb) {
  if (!origin) return cb(null, true);
  if (CORS_ORIGINS.length === 0) return cb(null, false);
  return cb(null, CORS_ORIGINS.includes(origin));
}

const apiCors = cors({
  origin: corsOriginFn,
  credentials: true,
});

function exportSessionTokens(credsContent) {
  const base64Creds = Buffer.from(credsContent).toString('base64');
  return [`Mantra~${base64Creds}`];
}

function safeSelfJid(sock) {
  const id = String(sock && sock.user && sock.user.id ? sock.user.id : '');
  const left = id.split('@')[0] || '';
  const number = (left.split(':')[0] || '').trim();
  if (!number) return null;
  return `${number}@s.whatsapp.net`;
}

function shouldRetry(retries, reason) {
  if (retries >= MAX_RETRIES) return false;
  if (reason === undefined || reason === null) return true;
  const retryable = [
    DisconnectReason.connectionClosed,
    DisconnectReason.connectionLost,
    DisconnectReason.timedOut,
    DisconnectReason.restartRequired,
  ];
  return retryable.includes(reason);
}

function makeSessionId() {
  return `session_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function sessionDirFor(id) {
  return path.join(__dirname, 'temp', id);
}

const sessions = new Map();

async function cleanupSession(session, removeFiles = true) {
  if (!session) return;

  if (session.ttlTimer) clearTimeout(session.ttlTimer);
  if (session.idleTimer) clearTimeout(session.idleTimer);

  if (session.sock) {
    try {
      await session.sock.end();
    } catch (_) {
      // ignore
    }
    session.sock = null;
  }

  if (removeFiles) {
    try {
      await fs.remove(session.sessionDir);
    } catch (_) {
      // ignore
    }
  }

  sessions.delete(session.id);
  log(session.id, 'Session cleaned', 'INFO');
}

function setIdleTimer(session) {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    session.emitter.emit('session_error', { message: 'Session expired due to inactivity.' });
    cleanupSession(session).catch(() => {});
  }, SESSION_IDLE_TTL_MS);
}

function emitStatus(session, status, extra) {
  session.status = status;
  session.lastEventAt = Date.now();
  session.emitter.emit('status', { status, ...(extra || {}) });
}

async function startSession(session) {
  await fs.ensureDir(session.sessionDir);
  emitStatus(session, 'starting');
  setIdleTimer(session);

  const { state, saveCreds } = await useMultiFileAuthState(session.sessionDir);
  const browser = Browsers.macOS('Chrome');

  let version;
  try {
    if (typeof fetchLatestBaileysVersion === 'function') {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    }
  } catch (e) {
    log(session.id, `Unable to fetch latest WA version tuple: ${e.message}`, 'WARNING');
  }

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
    },
    version,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser,
    connectTimeoutMs: 90_000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 10_000,
    emitOwnEvents: true,
    retryRequestDelayMs: 2_000,
    qrTimeout: 90_000,
    usePairingCode: session.method === 'code',
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async () => undefined,
  });

  session.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const connection = update.connection;
    const lastDisconnect = update.lastDisconnect;
    const qr = update.qr;

    if (connection) {
      emitStatus(session, connection);
      log(session.id, `Connection status: ${connection}`, 'INFO');
    }

    if (qr && session.method === 'qr') {
      try {
        const qrImage = await QRCode.toDataURL(qr);
        session.lastQr = qrImage;
        session.lastEventAt = Date.now();
        session.emitter.emit('qr', { qr: qrImage });
        setIdleTimer(session);
      } catch (e) {
        session.emitter.emit('session_error', { message: `Failed to generate QR: ${e.message}` });
      }
    }

    if (connection === 'open') {
      session.retries = 0;
      log(session.id, 'Successfully connected', 'SUCCESS');
      session.emitter.emit('connected', { ok: true });

      await delay(1200);
      const credsPath = path.join(session.sessionDir, 'creds.json');
      if (!fs.existsSync(credsPath)) {
        session.emitter.emit('session_error', { message: 'creds.json not found after connect' });
        await cleanupSession(session);
        return;
      }

      try {
        const credsContent = await fs.readFile(credsPath);
        const tokens = exportSessionTokens(credsContent);
        const userJid = safeSelfJid(sock);
        if (!userJid) throw new Error('Could not resolve self JID');

        for (const t of tokens) {
          await sock.sendMessage(userJid, { text: t });
          await delay(400);
        }

        await sock.sendMessage(userJid, {
          text:
            '╭━━━━━━━━━━━━━━━╮\n' +
            '│ *MANTRA CONNECTED* ✅\n' +
            '╰━━━━━━━━━━━━━━━╯\n\n' +
            '✓ Session sent above\n' +
            '✓ Keep it private and secure\n\n' +
            '_Powered by Mantra Inc_',
        });

        session.emitter.emit('exported', { legacy: true });

        if (LOG_SESSION_EXPORTS) {
          log(session.id, `Exported session tokens: ${tokens.map((t) => t.slice(0, 18)).join(', ')}...`, 'WARNING');
        }
      } catch (e) {
        session.emitter.emit('session_error', { message: `Failed to export session: ${e.message}` });
      } finally {
        await delay(2500);
        await cleanupSession(session);
      }
    }

    if (connection === 'close') {
      const reason = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode
        : undefined;
      const errorMsg = lastDisconnect && lastDisconnect.error && lastDisconnect.error.message
        ? lastDisconnect.error.message
        : 'Unknown error';

      log(session.id, `Connection closed: ${errorMsg}${reason ? ` (code ${reason})` : ''}`, 'WARNING');

      if (reason === DisconnectReason.loggedOut) {
        session.emitter.emit('session_error', { message: 'Logged out by WhatsApp. Start pairing again.' });
        await cleanupSession(session);
        return;
      }

      if (shouldRetry(session.retries || 0, reason)) {
        session.retries = (session.retries || 0) + 1;
        session.emitter.emit('status', { status: 'retrying', retry: session.retries, maxRetries: MAX_RETRIES });
        await delay(RETRY_DELAY_MS);
        startSession(session).catch((e) => {
          session.emitter.emit('session_error', { message: `Retry failed: ${e.message}` });
          cleanupSession(session).catch(() => {});
        });
      } else {
        session.emitter.emit('session_error', {
          message: `Connection failed after ${MAX_RETRIES} retries${reason ? ` (code ${reason})` : ''}`,
        });
        await cleanupSession(session);
      }
    }
  });

  if (session.method === 'code') {
    emitStatus(session, 'requesting_code');
    await delay(4500);
    if (session.sock !== sock) return;
    try {
      const code = await sock.requestPairingCode(session.phone);
      const formatted = code && code.match(/.{1,4}/g) ? code.match(/.{1,4}/g).join('-') : code;
      session.lastCode = formatted;
      session.lastEventAt = Date.now();
      session.emitter.emit('code', { code: formatted, expiresIn: 60 });
      setIdleTimer(session);
    } catch (e) {
      session.emitter.emit('session_error', { message: `Failed to generate pairing code: ${e.message}` });
    }
  } else {
    emitStatus(session, 'waiting_qr');
    setIdleTimer(session);
  }
}

process.on('SIGINT', async () => {
  log('SERVER', 'Shutting down gracefully...', 'WARNING');
  for (const s of sessions.values()) {
    await cleanupSession(s).catch(() => {});
  }
  process.exit(0);
});

async function cleanupOldTempOnStartup() {
  const tempDir = path.join(__dirname, 'temp');
  await fs.ensureDir(tempDir);
  const files = await fs.readdir(tempDir);
  for (const file of files) {
    const filePath = path.join(tempDir, file);
    try {
      const stats = await fs.stat(filePath);
      const age = Date.now() - stats.mtimeMs;
      if (age > 60 * 60_000) await fs.remove(filePath);
    } catch (_) {
      // ignore
    }
  }
}

setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - (s.createdAt || now) > SESSION_TTL_MS) {
      s.emitter.emit('session_error', { message: 'Session expired.' });
      cleanupSession(s).catch(() => {});
    }
  }
}, SESSION_CLEANUP_INTERVAL_MS).unref();

app.get('/pair', apiLimiter, apiCors, (req, res) => {
  res.status(405).json({ success: false, error: 'Method not allowed. Use POST /pair.' });
});

app.post('/pair', apiLimiter, apiCors, async (req, res) => {
  const method = String((req.body && req.body.method) || 'code');
  const phone = req.body ? req.body.phone : undefined;

  if (!['code', 'qr'].includes(method)) {
    return res.status(400).json({ success: false, error: 'Invalid method. Use "code" or "qr".' });
  }

  let cleanedPhone = null;
  if (method === 'code') {
    const v = validatePhone(phone);
    if (!v.valid) return res.status(400).json({ success: false, error: v.error });
    cleanedPhone = v.cleaned;
  }

  const id = makeSessionId();
  const session = {
    id,
    method,
    phone: cleanedPhone,
    createdAt: Date.now(),
    lastEventAt: Date.now(),
    sessionDir: sessionDirFor(id),
    emitter: new EventEmitter(),
    retries: 0,
    status: 'created',
    lastQr: null,
    lastCode: null,
    sock: null,
    ttlTimer: null,
    idleTimer: null,
  };

  sessions.set(id, session);
  session.ttlTimer = setTimeout(() => {
    session.emitter.emit('session_error', { message: 'Session expired.' });
    cleanupSession(session).catch(() => {});
  }, SESSION_TTL_MS);

  log(id, `New ${method.toUpperCase()} pairing request${cleanedPhone ? ` for ${cleanedPhone}` : ''}`, 'INFO');

  startSession(session).catch((e) => {
    session.emitter.emit('session_error', { message: `Failed to start session: ${e.message}` });
    cleanupSession(session).catch(() => {});
  });

  return res.json({ success: true, id, method, status: 'starting' });
});

app.get('/pair/events/:id', apiLimiter, apiCors, (req, res) => {
  const id = String(req.params.id || '');
  const session = sessions.get(id);
  if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('status', { status: session.status || 'starting' });
  if (session.lastCode) send('code', { code: session.lastCode, expiresIn: 60 });
  if (session.lastQr) send('qr', { qr: session.lastQr });

  const onStatus = (p) => send('status', p);
  const onCode = (p) => send('code', p);
  const onQr = (p) => send('qr', p);
  const onConnected = (p) => send('connected', p);
  const onExported = (p) => send('exported', p);
  const onError = (p) => send('error', p);

  session.emitter.on('status', onStatus);
  session.emitter.on('code', onCode);
  session.emitter.on('qr', onQr);
  session.emitter.on('connected', onConnected);
  session.emitter.on('exported', onExported);
  session.emitter.on('session_error', onError);

  const keepAlive = setInterval(() => {
    res.write('event: ping\n');
    res.write('data: {}\n\n');
  }, 15_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    session.emitter.off('status', onStatus);
    session.emitter.off('code', onCode);
    session.emitter.off('qr', onQr);
    session.emitter.off('connected', onConnected);
    session.emitter.off('exported', onExported);
    session.emitter.off('session_error', onError);
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', activeSessions: sessions.size, uptime: process.uptime() });
});

app.listen(PORT, async () => {
  await cleanupOldTempOnStartup();

  console.log('\n' + '='.repeat(56));
  console.log('Mantra-Pair Server Started');
  console.log('='.repeat(56));
  console.log(`Port: ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log('Pair: POST /pair');
  console.log('Events: GET /pair/events/:id');
  console.log('='.repeat(56) + '\n');
});
