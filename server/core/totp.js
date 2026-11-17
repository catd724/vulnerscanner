'use strict';

/**
 * terminal.ai - TOTP (RFC 6238) for Google Authenticator and compatible apps.
 *
 * Used in two independent places:
 *   - the vault gate, as a second factor on top of the master password
 *   - SSH keyboard-interactive auth, answering the "Verification code:" prompt
 *     that a server running the Google Authenticator PAM module asks for
 *
 * The codec and HMAC are local - node:crypto plus a 40-line base32 - and the
 * only dependency is the QR encoder used to draw the enrolment code.
 * Secrets are always handled as base32 strings at the edges and as raw bytes
 * inside, and they are stored only inside vault-sealed blobs.
 */

const crypto = require('crypto');
const qrcode = require('qrcode-generator');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_STEP = 30;
const DEFAULT_DIGITS = 6;
// One step either side: a phone whose clock drifts by a few seconds, or a code
// typed just as it rolls over, still authenticates. Wider than this starts
// meaningfully extending the window in which a shoulder-surfed code works.
const DEFAULT_WINDOW = 1;

/** Decode base32, tolerating the spaces and lowercase that authenticator apps show. */
function base32Decode(input) {
  const clean = String(input || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '');
  if (!clean) throw new Error('Secret is empty');

  let bits = 0;
  let value = 0;
  const out = [];

  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Secret is not valid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }

  if (out.length === 0) throw new Error('Secret is too short');
  return Buffer.from(out);
}

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** 20 bytes = 160 bits, the size RFC 4226 specifies for HMAC-SHA1. */
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** True when `secret` is something an authenticator app would accept. */
function isValidSecret(secret) {
  try {
    return base32Decode(secret).length >= 10;
  } catch {
    return false;
  }
}

function counterBuffer(counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  return buf;
}

/** The HOTP truncation from RFC 4226 §5.3. */
function hotp(keyBuffer, counter, digits = DEFAULT_DIGITS) {
  const digest = crypto.createHmac('sha1', keyBuffer).update(counterBuffer(counter)).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The code an authenticator app is showing right now. */
function generate(secret, { step = DEFAULT_STEP, digits = DEFAULT_DIGITS, now = Date.now() } = {}) {
  const counter = Math.floor(now / 1000 / step);
  return hotp(base32Decode(secret), counter, digits);
}

/**
 * Check a submitted code against the accepted window.
 * Compares in constant time so a wrong code leaks nothing through timing.
 */
function verify(
  secret,
  token,
  { step = DEFAULT_STEP, digits = DEFAULT_DIGITS, window = DEFAULT_WINDOW, now = Date.now() } = {}
) {
  const cleaned = String(token || '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(cleaned)) return false;

  const key = base32Decode(secret);
  const counter = Math.floor(now / 1000 / step);
  const submitted = Buffer.from(cleaned, 'utf8');

  let matched = false;
  // Every candidate is checked even after a hit: bailing out early would make
  // "code from the previous step" measurably faster than "no match at all".
  for (let drift = -window; drift <= window; drift++) {
    const candidate = Buffer.from(hotp(key, counter + drift, digits), 'utf8');
    if (
      candidate.length === submitted.length &&
      crypto.timingSafeEqual(candidate, submitted)
    ) {
      matched = true;
    }
  }
  return matched;
}

/** Seconds until the current code rolls over - the UI shows this as a countdown. */
function secondsRemaining({ step = DEFAULT_STEP, now = Date.now() } = {}) {
  return step - Math.floor(now / 1000) % step;
}

/**
 * The otpauth:// URI an authenticator app imports.
 * Google Authenticator reads it from a QR code; typing the base32 secret into
 * "Enter a setup key" reaches exactly the same state.
 */
function otpauthUri({ secret, account, issuer = 'AI Terminal', digits = DEFAULT_DIGITS, step = DEFAULT_STEP }) {
  const label = encodeURIComponent(`${issuer}:${account || 'vault'}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(step),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Render a QR code for an otpauth:// URI as an SVG data URI.
 *
 * Drawn as one path of 1x1 modules on a white card: scanners want dark on
 * light, and the app's own background is nearly black. The quiet zone is the
 * four modules the spec asks for, without which a lot of phone cameras simply
 * refuse to lock on. Error correction M leaves ~15% redundancy, which is what
 * every authenticator app's own QR uses.
 */
function qrDataUri(text, { margin = 4, ecc = 'M' } = {}) {
  const qr = qrcode(0, ecc); // type 0 = pick the smallest version that fits
  qr.addData(String(text));
  qr.make();

  const count = qr.getModuleCount();
  const span = count + margin * 2;

  let path = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        path += `M${col + margin} ${row + margin}h1v1h-1z`;
      }
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="Authenticator setup QR code">` +
    `<rect width="${span}" height="${span}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#08090f"/>` +
    `</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/**
 * Does this keyboard-interactive prompt want a one-time code?
 * Matches what the Google Authenticator PAM module and common 2FA PAM stacks
 * actually print, and deliberately does not match a plain "Password:".
 */
const OTP_PROMPT = /verification code|one[-\s]?time|\botp\b|\btotp\b|authenticator|2fa|two[-\s]?factor|token code|passcode/i;

function looksLikeOtpPrompt(prompt) {
  return OTP_PROMPT.test(String(prompt || ''));
}

module.exports = {
  DEFAULT_STEP,
  DEFAULT_DIGITS,
  base32Decode,
  base32Encode,
  generateSecret,
  isValidSecret,
  generate,
  verify,
  secondsRemaining,
  otpauthUri,
  qrDataUri,
  looksLikeOtpPrompt,
};
