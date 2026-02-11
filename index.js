const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason, Browsers, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// Enhanced logging with colors and levels
const LOG_LEVELS = {
    INFO: '\x1b[36m[INFO]\x1b[0m',
    SUCCESS: '\x1b[32m[SUCCESS]\x1b[0m',
    WARNING: '\x1b[33m[WARNING]\x1b[0m',
    ERROR: '\x1b[31m[ERROR]\x1b[0m'
};

const log = (id, msg, level = 'INFO') => {
    console.log(`[${new Date().toLocaleTimeString()}] ${LOG_LEVELS[level]} [${id}] ${msg}`);
};

const respondIfPending = (res, status, payload) => {
    if (res && !res.headersSent) {
        res.status(status).json(payload);
    }
};

// Track active connections and retry attempts
const activeSockets = new Map();
const sessionRetries = new Map();
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;

// Graceful shutdown handler
process.on('SIGINT', async () => {
    log('SERVER', 'Shutting down gracefully...', 'WARNING');
    for (const [id, sock] of activeSockets.entries()) {
        try {
            await sock.end();
            log(id, 'Socket closed', 'INFO');
        } catch (e) {
            log(id, `Error closing socket: ${e.message}`, 'ERROR');
        }
    }
    process.exit(0);
});

// Phone number validation
function validatePhone(phone) {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length < 10 || cleaned.length > 15) {
        return { valid: false, error: 'Phone number must be 10-15 digits' };
    }
    return { valid: true, cleaned };
}

// Enhanced session cleanup with retry tracking
async function cleanupSession(id, removeFiles = true) {
    const sessionDir = path.join(__dirname, 'temp', id);

    if (activeSockets.has(id)) {
        try {
            const sock = activeSockets.get(id);
            await sock.end();
            log(id, 'Socket terminated', 'INFO');
        } catch (e) {
            log(id, `Error ending socket: ${e.message}`, 'WARNING');
        }
        activeSockets.delete(id);
    }

    sessionRetries.delete(id);

    if (removeFiles) {
        try {
            await fs.remove(sessionDir);
            log(id, 'Session files cleaned', 'INFO');
        } catch (e) {
            log(id, `Error removing session: ${e.message}`, 'WARNING');
        }
    }
}

// Check if session can be recovered
async function canRecoverSession(sessionDir) {
    const credsPath = path.join(sessionDir, 'creds.json');

    if (!fs.existsSync(credsPath)) return false;

    try {
        const stats = fs.statSync(credsPath);
        if (stats.size < 100) return false;

        const creds = await fs.readJson(credsPath);
        return creds && creds.me && creds.me.id;
    } catch (e) {
        return false;
    }
}

// Enhanced retry logic
function shouldRetry(id, reason) {
    const retries = sessionRetries.get(id) || 0;

    if (retries >= MAX_RETRIES) {
        log(id, `Max retries (${MAX_RETRIES}) reached`, 'ERROR');
        return false;
    }

    // Some websocket failures surface without a mapped status code.
    if (reason === undefined || reason === null) {
        return true;
    }

    const retryableReasons = [
        DisconnectReason.connectionClosed,
        DisconnectReason.connectionLost,
        DisconnectReason.timedOut,
        DisconnectReason.restartRequired
    ];

    return retryableReasons.includes(reason);
}

async function startMantraSession(id, phone, res = null, method = 'code') {
    const sessionDir = path.join(__dirname, 'temp', id);
    const credsPath = path.join(sessionDir, 'creds.json');

    // Check for session recovery
    const isRecovering = await canRecoverSession(sessionDir);

    if (isRecovering) {
        log(id, 'Recovering existing session...', 'INFO');
    }

    try {
        await fs.ensureDir(sessionDir);

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const browser = Browsers.macOS("Chrome");
        let version;

        try {
            if (typeof fetchLatestBaileysVersion === 'function') {
                const latest = await fetchLatestBaileysVersion();
                version = latest.version;

                if (!latest.isLatest) {
                    log(id, `Using latest WA version tuple: ${latest.version.join('.')}`, 'INFO');
                }
            } else {
                log(id, 'Baileys version helper unavailable, using library default WA version', 'WARNING');
            }
        } catch (e) {
            log(id, `Unable to fetch latest WA version, using library default: ${e.message}`, 'WARNING');
        }

        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            version,
            printQRInTerminal: method === 'qr', // Enable QR terminal printing for QR mode
            logger: pino({ level: "silent" }),
            browser: browser,
            connectTimeoutMs: 90000, // Increased from 60s to 90s
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            retryRequestDelayMs: 2000,
            qrTimeout: 90000, // Add explicit QR/pairing timeout
            usePairingCode: method === 'code', // Use pairing code only if method is 'code'
            syncFullHistory: false, // Disable history sync for faster connection
            markOnlineOnConnect: false, // Don't mark online immediately
            getMessage: async () => undefined // Prevent message fetch errors
        });

        activeSockets.set(id, sock);
        sock.ev.on('creds.update', saveCreds);

        // Connection state handler
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (connection) {
                log(id, `Connection status: ${connection}`, 'INFO');
            }

            // Handle QR code generation
            if (qr && method === 'qr' && res && !res.headersSent) {
                try {
                    log(id, 'QR code received, generating image...', 'INFO');
                    const qrImage = await QRCode.toDataURL(qr);

                    log(id, 'QR code generated successfully', 'SUCCESS');
                    res.json({
                        success: true,
                        method: 'qr',
                        qr: qrImage,
                        id: id,
                        message: 'Scan this QR code with WhatsApp'
                    });
                } catch (err) {
                    log(id, `QR generation failed: ${err.message}`, 'ERROR');
                    if (!res.headersSent) {
                        res.status(500).json({
                            success: false,
                            error: 'Failed to generate QR code',
                            details: err.message
                        });
                    }
                }
            }

            // Handle successful connection
            if (connection === 'open') {
                log(id, 'Successfully connected!', 'SUCCESS');
                sessionRetries.delete(id);

                await delay(1500);

                if (fs.existsSync(credsPath)) {
                    try {
                        const credsContent = await fs.readFile(credsPath);
                        const base64 = Buffer.from(credsContent).toString('base64');
                        const sessionID = 'Mantra~' + base64;
                        const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';

                        log(id, `Sending session to ${sock.user.name || userJid}`, 'INFO');

                        // Send session ID
                        await sock.sendMessage(userJid, { text: sessionID });
                        await delay(800);

                        // Send confirmation message
                        await sock.sendMessage(userJid, {
                            text: `╭━━━━━━━━━━━━━━━╮
│ *MANTRA CONNECTED* ✅
╰━━━━━━━━━━━━━━━╯

✓ Session ID sent above
✓ Keep it private and secure
✓ Valid until you logout

_Powered by MidKnight-Core_`
                        });

                        log(id, 'Session delivered successfully', 'SUCCESS');

                        // Backup session to console
                        console.log(`\n${'='.repeat(50)}`);
                        console.log(`SESSION ID FOR ${sock.user.name || phone}`);
                        console.log('='.repeat(50));
                        console.log(sessionID);
                        console.log('='.repeat(50) + '\n');

                    } catch (e) {
                        log(id, `Message send failed: ${e.message}`, 'ERROR');

                        // Fallback: Log to console
                        const credsContent = await fs.readFile(credsPath);
                        const base64 = Buffer.from(credsContent).toString('base64');
                        const sessionID = 'Mantra~' + base64;

                        console.log(`\n${'='.repeat(50)}`);
                        console.log('⚠️  FALLBACK SESSION ID');
                        console.log('='.repeat(50));
                        console.log(sessionID);
                        console.log('='.repeat(50) + '\n');
                    }

                    await delay(5000);
                    await sock.end();
                    await cleanupSession(id);
                }
            }

            // Handle connection close
            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                const errorMsg = lastDisconnect?.error?.message || 'Unknown error';

                log(id, `Connection closed: ${errorMsg} (Code: ${reason})`, 'WARNING');

                // Check if logged out
                if (reason === DisconnectReason.loggedOut) {
                    log(id, 'Logged out by user', 'INFO');
                    respondIfPending(res, 401, {
                        success: false,
                        error: 'Session logged out',
                        details: 'WhatsApp ended this session. Start pairing again.'
                    });
                    await cleanupSession(id);
                    return;
                }

                // Handle retries
                if (shouldRetry(id, reason)) {
                    const retries = sessionRetries.get(id) || 0;
                    sessionRetries.set(id, retries + 1);

                    log(id, `Retry ${retries + 1}/${MAX_RETRIES} in ${RETRY_DELAY / 1000}s...`, 'WARNING');

                    // Cleanup current socket without removing files
                    if (activeSockets.has(id)) {
                        try {
                            await sock.end();
                        } catch (e) {
                            log(id, `Error ending socket during retry: ${e.message}`, 'WARNING');
                        }
                        activeSockets.delete(id);
                    }

                    await delay(RETRY_DELAY);

                    startMantraSession(id, phone, res && !res.headersSent ? res : null, method);
                } else {
                    log(id, 'Connection failed permanently', 'ERROR');
                    respondIfPending(res, 503, {
                        success: false,
                        error: 'Connection failed',
                        details: `Socket closed after ${MAX_RETRIES} retries${reason ? ` (code ${reason})` : ''}`
                    });
                    await cleanupSession(id);
                }
            }
        });

        // Request pairing code for new sessions (only for 'code' method)
        if (res && !isRecovering && method === 'code') {
            log(id, 'Initializing socket...', 'INFO');

            // Wait for socket to be ready before requesting pairing code
            await delay(5000);

            // Check if socket is still active
            if (!activeSockets.has(id)) {
                log(id, 'Socket rotated before pairing request, waiting for retry cycle', 'WARNING');
                return;
            }

            log(id, 'Requesting pairing code...', 'INFO');

            try {
                const code = await sock.requestPairingCode(phone);
                const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;

                log(id, `Pairing code generated: ${formattedCode}`, 'SUCCESS');

                res.json({
                    success: true,
                    code: formattedCode,
                    id: id,
                    phone: phone,
                    expiresIn: 60
                });
            } catch (err) {
                log(id, `Code generation failed: ${err.message}`, 'ERROR');
                const reason = err?.output?.statusCode || err?.data?.statusCode || err?.statusCode;

                // Let the connection close handler drive retry flow for transient failures.
                if (!shouldRetry(id, reason)) {
                    await cleanupSession(id);
                    respondIfPending(res, 500, {
                        success: false,
                        error: 'Failed to generate pairing code',
                        details: err.message
                    });
                }
            }
        } else if (res && isRecovering) {
            log(id, 'Using recovered session', 'INFO');
            res.json({
                success: true,
                status: 'recovering',
                message: 'Recovering previous session. This may take a moment...',
                id: id
            });
        } else if (res && method === 'qr') {
            // For QR mode, just log that we're waiting for QR code
            log(id, 'Waiting for QR code...', 'INFO');
        }

    } catch (err) {
        log(id, `Fatal error: ${err.message}`, 'ERROR');
        console.error(err.stack);

        await cleanupSession(id);

        if (res && !res.headersSent) {
            res.status(500).json({
                success: false,
                error: 'Internal server error',
                details: err.message
            });
        }
    }
}

// API Routes
app.get('/pair', async (req, res) => {
    const phone = req.query.phone;
    const method = req.query.method || 'code'; // Default to pairing code

    // Validate method
    if (!['code', 'qr'].includes(method)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid method. Use "code" or "qr"'
        });
    }

    // Phone number only required for pairing code method
    if (method === 'code' && !phone) {
        return res.status(400).json({
            success: false,
            error: 'Phone number is required for pairing code method'
        });
    }

    // Validate phone number if provided
    if (phone) {
        const validation = validatePhone(phone);
        if (!validation.valid) {
            return res.status(400).json({
                success: false,
                error: validation.error
            });
        }
    }

    const id = 'session_' + Date.now() + '_' + Math.random().toString(36).substring(7);
    const phoneNumber = phone ? validatePhone(phone).cleaned : null;

    log(id, `New ${method.toUpperCase()} pairing request${phoneNumber ? ' for ' + phoneNumber : ''}`, 'INFO');

    startMantraSession(id, phoneNumber, res, method);
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        activeSessions: activeSockets.size,
        uptime: process.uptime()
    });
});

// Cleanup old temp files on startup
async function cleanupOldSessions() {
    const tempDir = path.join(__dirname, 'temp');

    try {
        await fs.ensureDir(tempDir);
        const files = await fs.readdir(tempDir);

        for (const file of files) {
            const filePath = path.join(tempDir, file);
            const stats = await fs.stat(filePath);
            const age = Date.now() - stats.mtimeMs;

            // Remove sessions older than 1 hour
            if (age > 3600000) {
                await fs.remove(filePath);
                console.log(`Cleaned old session: ${file}`);
            }
        }
    } catch (e) {
        console.error('Cleanup error:', e.message);
    }
}

app.listen(PORT, async () => {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 Mantra-Pair Server Started');
    console.log('='.repeat(50));
    console.log(`📡 Port: ${PORT}`);
    console.log(`🔗 Endpoint: http://localhost:${PORT}/pair?phone=YOUR_NUMBER`);
    console.log(`❤️  Health: http://localhost:${PORT}/health`);
    console.log('='.repeat(50) + '\n');

    await cleanupOldSessions();
});
