'use strict';
/**
 * adb-direct.js — Minimal ADB-over-TCP using Node built-ins only.
 * Connects directly to adbd on the TV (port 5555) without a local ADB server.
 * Uses Node crypto for RSA auth. Stores key in userData so TV only asks once.
 */

const net    = require('net');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { app } = require('electron');

// ── ADB wire protocol constants ───────────────────────────────────────────────
const CMD = {
  CNXN: 0x4e584e43,
  AUTH: 0x48545541,
  OPEN: 0x4e45504f,
  OKAY: 0x59414b4f,
  CLSE: 0x45534c43,
  WRTE: 0x45545257,
};
const AUTH_TOKEN       = 1;
const AUTH_SIGNATURE   = 2;
const AUTH_RSAPUBLICKEY = 3;
const PROTOCOL_VERSION = 0x01000000;
const MAX_PAYLOAD      = 256 * 1024;

// ── RSA key management ────────────────────────────────────────────────────────
let _keys = null;
function getKeys() {
  if (_keys) return _keys;
  const dir     = app.getPath('userData');
  const privFile = path.join(dir, 'adbkey');
  const pubFile  = path.join(dir, 'adbkey.pub');

  if (!fs.existsSync(privFile)) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    fs.writeFileSync(privFile, privateKey);
    fs.writeFileSync(pubFile,  publicKey + ' callisto@laptop\0');
  }

  _keys = {
    private: fs.readFileSync(privFile),
    public:  fs.readFileSync(pubFile),
  };
  return _keys;
}

// ── ADB message encode/decode ─────────────────────────────────────────────────
function encode(cmd, arg0, arg1, data) {
  const d = data ? Buffer.from(data) : Buffer.alloc(0);
  const h = Buffer.alloc(24);
  h.writeUInt32LE(cmd,                    0);
  h.writeUInt32LE(arg0 >>> 0,             4);
  h.writeUInt32LE(arg1 >>> 0,             8);
  h.writeUInt32LE(d.length,              12);
  h.writeUInt32LE(crc32(d),              16);
  h.writeUInt32LE((cmd ^ 0xFFFFFFFF) >>> 0, 20);
  return Buffer.concat([h, d]);
}

function crc32(buf) {
  let c = 0;
  for (const b of buf) c = (c + b) >>> 0;
  return c;
}

function parseHeader(buf) {
  if (buf.length < 24) return null;
  return {
    cmd:     buf.readUInt32LE(0),
    arg0:    buf.readUInt32LE(4),
    arg1:    buf.readUInt32LE(8),
    length:  buf.readUInt32LE(12),
    crc32:   buf.readUInt32LE(16),
    magic:   buf.readUInt32LE(20),
  };
}

// ── Run a shell command on TV via ADB TCP ─────────────────────────────────────
function shell(host, cmd, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const keys  = getKeys();
    const sock  = new net.Socket();
    let   buf   = Buffer.alloc(0);
    let   localId  = 1;
    let   remoteId = 0;
    let   output   = '';
    let   state    = 'init';
    let   timer;

    const fail = (msg) => {
      clearTimeout(timer);
      try { sock.destroy(); } catch(_) {}
      reject(new Error(msg));
    };

    timer = setTimeout(() => fail('ADB command timed out'), timeoutMs);

    sock.connect(5555, host, () => {
      // Send CNXN — identify as an ADB host
      const id = 'host::features=shell_v2,cmd,stat_v2,ls_v2,fixed_push_mkdir,apex,abb,fixed_push_symlink_timestamp,abb_exec,remount_shell,track_app,sendrecv_v2,sendrecv_v2_brotli,sendrecv_v2_lz4,sendrecv_v2_zstd,sendrecv_v2_dry_run_send_callback\0';
      sock.write(encode(CMD.CNXN, PROTOCOL_VERSION, MAX_PAYLOAD, id));
    });

    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);

      while (buf.length >= 24) {
        const hdr = parseHeader(buf);
        if (!hdr) break;
        if (buf.length < 24 + hdr.length) break;

        const data = buf.slice(24, 24 + hdr.length);
        buf = buf.slice(24 + hdr.length);

        if (hdr.cmd === CMD.CNXN) {
          state = 'connected';
          // Open a shell channel
          sock.write(encode(CMD.OPEN, localId, 0, `shell:${cmd}\0`));

        } else if (hdr.cmd === CMD.AUTH) {
          if (hdr.arg0 === AUTH_TOKEN) {
            // Sign the token with our private key
            const sign = crypto.createSign('SHA1');
            sign.update(data);
            const sig = sign.sign(keys.private);
            sock.write(encode(CMD.AUTH, AUTH_SIGNATURE, 0, sig));
          } else if (hdr.arg0 === AUTH_TOKEN) {
            // Token again — TV rejected signature, send public key
            sock.write(encode(CMD.AUTH, AUTH_RSAPUBLICKEY, 0, keys.public));
          }

        } else if (hdr.cmd === CMD.OKAY) {
          remoteId = hdr.arg0;
          // Send OKAY back
          sock.write(encode(CMD.OKAY, localId, remoteId));

        } else if (hdr.cmd === CMD.WRTE) {
          remoteId = hdr.arg0;
          output += data.toString();
          // Acknowledge
          sock.write(encode(CMD.OKAY, localId, remoteId));

        } else if (hdr.cmd === CMD.CLSE) {
          clearTimeout(timer);
          try { sock.destroy(); } catch(_) {}
          resolve(output.trim());
          return;
        }
      }
    });

    sock.on('error', err => {
      // If AUTH rejected (first time) send public key
      if (state === 'connected' && err.code === 'ECONNRESET') {
        fail('TV rejected ADB connection. Please check TV shows "Allow ADB debugging?" and tap Allow.');
      } else {
        fail('ADB error: ' + err.message);
      }
    });

    sock.on('close', () => {
      clearTimeout(timer);
      if (output) resolve(output.trim());
      else reject(new Error('ADB connection closed'));
    });
  });
}

// ── AUTH: handle the two-step auth properly ────────────────────────────────────
// (patched version with correct AUTH flow)
function shellWithAuth(host, cmd, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const keys   = getKeys();
    const sock   = new net.Socket();
    let   rxBuf  = Buffer.alloc(0);
    let   localId  = 1;
    let   remoteId = 0;
    let   output   = '';
    let   authStep = 0; // 0=none, 1=sent sig, 2=sent pubkey
    let   timer;

    const done = (err, result) => {
      clearTimeout(timer);
      try { sock.destroy(); } catch(_) {}
      if (err) reject(err); else resolve(result);
    };

    timer = setTimeout(() => done(new Error('Timed out — if TV showed "Allow ADB debugging?", tap Allow and try again')), timeoutMs);

    sock.connect(5555, host, () => {
      const banner = 'host::features=shell_v2\0';
      sock.write(encode(CMD.CNXN, PROTOCOL_VERSION, MAX_PAYLOAD, banner));
    });

    sock.on('data', chunk => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      while (rxBuf.length >= 24) {
        const hdr = parseHeader(rxBuf);
        if (!hdr || rxBuf.length < 24 + hdr.length) break;
        const payload = rxBuf.slice(24, 24 + hdr.length);
        rxBuf = rxBuf.slice(24 + hdr.length);

        switch (hdr.cmd) {
          case CMD.CNXN:
            // TV identified itself — open shell
            sock.write(encode(CMD.OPEN, localId, 0, `shell:${cmd}\0`));
            break;

          case CMD.AUTH:
            if (hdr.arg0 === AUTH_TOKEN && authStep === 0) {
              authStep = 1;
              try {
                const sig = crypto.sign('SHA1', payload, keys.private);
                sock.write(encode(CMD.AUTH, AUTH_SIGNATURE, 0, sig));
              } catch(_) {
                // If signing fails, send public key directly
                authStep = 2;
                sock.write(encode(CMD.AUTH, AUTH_RSAPUBLICKEY, 0, keys.public));
              }
            } else if (hdr.arg0 === AUTH_TOKEN && authStep === 1) {
              // Signature rejected — send public key (TV will show auth dialog)
              authStep = 2;
              sock.write(encode(CMD.AUTH, AUTH_RSAPUBLICKEY, 0, keys.public));
            }
            break;

          case CMD.OKAY:
            remoteId = hdr.arg0;
            sock.write(encode(CMD.OKAY, localId, remoteId));
            break;

          case CMD.WRTE:
            remoteId = hdr.arg0;
            output += payload.toString();
            sock.write(encode(CMD.OKAY, localId, remoteId));
            break;

          case CMD.CLSE:
            done(null, output.trim());
            return;
        }
      }
    });

    sock.on('error', err => done(new Error('ADB: ' + err.message)));
    sock.on('close', () => { if (output) done(null, output.trim()); });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────
const APP_PACKAGES = {
  youtube : 'com.google.android.youtube.tv',
  netflix : 'com.netflix.ninja',
  spotify : 'com.spotify.tv.android',
  prime   : 'com.amazon.amazonvideo.livingroom',
};

async function launchApp(host, pkg) {
  return shellWithAuth(host, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
}

async function openYouTube(host, videoId) {
  return shellWithAuth(host,
    `am start -a android.intent.action.VIEW -d "https://www.youtube.com/watch?v=${videoId}" -n ${APP_PACKAGES.youtube}/.TvMainActivity`
  );
}

async function openApp(host, appName) {
  const pkg = APP_PACKAGES[appName.toLowerCase()];
  if (!pkg) throw new Error('Unknown app: ' + appName);
  return launchApp(host, pkg);
}

module.exports = { shellWithAuth, launchApp, openYouTube, openApp, APP_PACKAGES };
