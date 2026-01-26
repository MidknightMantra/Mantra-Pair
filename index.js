const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());
app.use(express.static('public')); // Serve the frontend

// Store active intervals/cleanup jobs if needed (simplified here)

app.get('/pair', async (req, res) => {
    const phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    // Create a unique ID for this session request to avoid conflicts
    const id = 'session_' + Math.random().toString(36).substring(7);
    const sessionDir = path.join(__dirname, 'temp', id);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: Browsers.macOS("Chrome"), // Pairing codes work best with this signature
        });

        // Handle Auth State
        sock.ev.on('creds.update', saveCreds);

        // Handle Connection
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                await delay(500); // Wait for creds to flush
                
                // THE GOLDEN EXTRACTION
                const credsPath = path.join(sessionDir, 'creds.json');
                
                if (fs.existsSync(credsPath)) {
                    const credsContent = await fs.readFile(credsPath);
                    // Encode to Base64
                    const base64 = Buffer.from(credsContent).toString('base64');
                    
                    // ADD PREFIX HERE
                    const sessionID = 'Mantra~' + base64; 

                    console.log(`[${id}] Session Generated: ${sessionID.substring(0, 20)}...`);
                    
                    // Note: In a real app with sockets, you'd emit this here.
                    // But for this polling architecture, we just leave the file for the /check endpoint.
                }
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                if (reason !== DisconnectReason.loggedOut) {
                    // Don't reconnect for a generator, just fail/stop
                }
                // Cleanup happens in the check endpoint or via a cron job in prod
            }
        });

        // Request Pairing Code
        await delay(1500);
        const code = await sock.requestPairingCode(phone);
        
        // Return the code to the frontend immediately
        res.json({ code: code?.match(/.{1,4}/g)?.join("-") || code, id: id });

        // Polling endpoint for this specific ID
        app.get('/check/' + id, async (req, res) => {
            const credsPath = path.join(__dirname, 'temp', id, 'creds.json');
            
            // Check if creds exist
            if (fs.existsSync(credsPath)) {
                // Check if connection is actually open (file size check is a simple hack)
                const stats = fs.statSync(credsPath);
                if (stats.size > 100) { 
                    const content = fs.readFileSync(credsPath);
                    const base64 = Buffer.from(content).toString('base64');
                    
                    // ADD PREFIX HERE TO RESPONSE
                    const session = 'Mantra~' + base64;
                    
                    // Self Destruct the temp folder
                    try {
                        await sock.end();
                    } catch (e) {} // ignore error if already closed
                    
                    fs.remove(path.join(__dirname, 'temp', id));
                    
                    return res.json({ status: 'success', session: session });
                }
            }
            res.json({ status: 'waiting' });
        });

    } catch (err) {
        console.error(err);
        if (fs.existsSync(sessionDir)) fs.remove(sessionDir);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.listen(PORT, () => {
    console.log(`Mantra-Pair running on port ${PORT}`);
});
