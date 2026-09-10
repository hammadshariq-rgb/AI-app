'use strict';
/**
 * adb-direct.js — ADB over TCP using the system's adb.exe
 * Finds adb.exe from common Android SDK install locations.
 * Falls back to PATH. Much more reliable than implementing the wire protocol manually.
 */

const { execFile, exec } = require('child_process');
const path = require('path');
const fs   = require('fs');

// ── Find adb.exe on this Windows machine ──────────────────────────────────────
function findAdb() {
  const candidates = [
    // Android Studio default
    path.join(process.env.LOCALAPPDATA  || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    // Chocolatey / scoop
    path.join(process.env.ProgramFiles  || '', 'Android', 'android-sdk', 'platform-tools', 'adb.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Android', 'android-sdk', 'platform-tools', 'adb.exe'),
    // Manual SDK installs
    'C:\\android-sdk\\platform-tools\\adb.exe',
    'C:\\Android\\platform-tools\\adb.exe',
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch(_) {}
  }
  return null; // not found — will try PATH
}

// ── Run adb command, return stdout string ─────────────────────────────────────
function adbExec(args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const adbPath = findAdb() || 'adb'; // fall back to PATH
    execFile(adbPath, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message));
      resolve((stdout || '').trim());
    });
  });
}

// ── Connect to TV via TCP ──────────────────────────────────────────────────────
async function connectToDevice(host, port = 5555) {
  const out = await adbExec(['connect', `${host}:${port}`], 8000);
  // "connected to 192.168.x.x:5555" or "already connected"
  if (/connected to|already connected/i.test(out)) return true;
  throw new Error(out || 'ADB connect failed');
}

// ── Run a shell command on TV ─────────────────────────────────────────────────
async function shellWithAuth(host, cmd, timeoutMs = 10000) {
  // Connect first (idempotent)
  await connectToDevice(host);
  return adbExec(['-s', `${host}:5555`, 'shell', cmd], timeoutMs);
}

// ── Public API ─────────────────────────────────────────────────────────────────
const APP_PACKAGES = {
  youtube : 'com.google.android.youtube.tv',
  netflix : 'com.netflix.ninja',
  spotify : 'com.spotify.tv.android',
  prime   : 'com.amazon.amazonvideo.livingroom',
};

async function launchApp(host, pkg) {
  await connectToDevice(host);
  return adbExec(['-s', `${host}:5555`, 'shell',
    `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`], 8000);
}

async function openYouTube(host, videoId) {
  await connectToDevice(host);
  return adbExec(['-s', `${host}:5555`, 'shell',
    `am start -a android.intent.action.VIEW -d "https://www.youtube.com/watch?v=${videoId}"`], 8000);
}

async function openApp(host, appName) {
  const pkg = APP_PACKAGES[appName.toLowerCase()];
  if (!pkg) throw new Error('Unknown app: ' + appName);
  return launchApp(host, pkg);
}

// ── Check if adb.exe is available ─────────────────────────────────────────────
function isAdbAvailable() {
  if (findAdb()) return true;
  // Check PATH
  try {
    require('child_process').execFileSync('adb', ['version'], { timeout: 3000, windowsHide: true });
    return true;
  } catch(_) { return false; }
}

module.exports = { shellWithAuth, connectToDevice, launchApp, openYouTube, openApp, APP_PACKAGES, isAdbAvailable, findAdb };
