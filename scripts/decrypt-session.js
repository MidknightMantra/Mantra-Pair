#!/usr/bin/env node
const crypto = require('crypto');

function b64urlDecodeToBuf(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return Buffer.from(b64 + pad, 'base64');
}

function usage() {
  console.error('Usage: SESSION_SECRET=... node scripts/decrypt-session.js MantraEnc~<token>');
  process.exit(2);
}

const token = process.argv[2];
if (!token || !token.startsWith('MantraEnc~')) usage();

const secret = String(process.env.SESSION_SECRET || '').trim();
if (!secret) {
  console.error('SESSION_SECRET is required');
  process.exit(2);
}

const packed = b64urlDecodeToBuf(token.slice('MantraEnc~'.length));
if (packed.length < 12 + 16 + 1) {
  console.error('Token too short');
  process.exit(2);
}

const iv = packed.subarray(0, 12);
const tag = packed.subarray(12, 28);
const ciphertext = packed.subarray(28);

const key = crypto.scryptSync(secret, 'mantra-pair', 32);
const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
decipher.setAuthTag(tag);

let plaintext;
try {
  plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
} catch (e) {
  console.error(`Decrypt failed: ${e.message}`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(plaintext.toString('utf8'));
} catch (e) {
  console.error(`Invalid payload JSON: ${e.message}`);
  process.exit(1);
}

if (!parsed || parsed.v !== 1 || typeof parsed.creds !== 'string') {
  console.error('Unexpected payload format');
  process.exit(1);
}

// Output original creds.json content to stdout.
process.stdout.write(Buffer.from(parsed.creds, 'base64'));

