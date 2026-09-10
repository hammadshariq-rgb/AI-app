'use strict';
/**
 * adb-direct.js — ADB over TCP using adb.exe
 * Auto-downloads platform-tools if adb.exe not found.
 */

const { execFile }  = require('child_process');
const path          = require('path');
const fs            = require('fs');
const https         = require('https');
const { app }       = require('electron');
const AdmZip        = require('adm-zip'); // bundled with electron-builder builds

// ── Bundled adb location (auto-downloaded into userData) ─────────────────────
function bundledAdbDir() {
  return path.join(app.getPath('userData'), 'platform-tools');
}
function bundledAdbPath() {
  return path.join(bundledAdbDir(), 'adb.exe');
}

// ── Find adb.exe: bundled first, then common SDK installs, then PATH ──────────
function findAdb() {
  // 1. Our bundled/downloaded copy
  const bd = bundledAdbPath();
  try { if (fs.existsSync(bd)) return bd; } catch(_) {}

  // 2. Common SDK install locations
  const candidates = [
    path.join(process.env.LOCALAPPDATA  || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    path.join(process.env.ProgramFiles  || '', 'Android', 'android-sdk', 'platform-tools', 'adb.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Android', 'android-sdk', 'platform-tools', 'adb.exe'),
    path.join(process.env.USERPROFILE   || '', 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    'C:\\platform-tools\\adb.exe',
    'C:\\android-sdk\\platform-tools\\adb.exe',
    'C:\\Android\\platform-tools\\adb.exe',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch(_) {}
  }
  return null;
}

function isAdbAvailable() {
  if (findAdb()) return true;
  try { require('child_process').execFileSync('adb', ['version'], { timeout: 2000, windowsHide: true }); return true; } catch(_) { return false; }
}

// ── Auto-download platform-tools from Google ──────────────────────────────────
// Returns { ok, path, error }
async function downloadAdb(onProgress) {
  const PLATFORM_TOOLS_URL = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
  const zipPath = path.join(app.getPath('userData'), 'platform-tools.zip');
  const outDir  = bundledAdbDir();

  // Download zip
  onProgress && onProgress('Downloading ADB tools (≈10 MB)…');
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(zipPath);
    https.get(PLATFORM_TOOLS_URL, { timeout: 60000 }, res => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      res.on('data', chunk => {
        received += chunk.length;
        if (onProgress && total) onProgress(`Downloading ADB tools… ${Math.round(received/total*100)}%`);
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject).on('timeout', () => reject(new Error('Download timed out')));
  });

  // Extract
  onProgress && onProgress('Extracting ADB tools…');
  try {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(app.getPath('userData'), true);
    // zip extracts to platform-tools/ directory — that's exactly what we want
  } catch (e) {
    // adm-zip might not be bundled — try PowerShell expand
    await new Promise((resolve, reject) => {
      const { exec } = require('child_process');
      exec(`powershell -WindowStyle Hidden -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${app.getPath('userData')}' -Force"`,
        { windowsHide: true, timeout: 30000 }, err => err ? reject(err) : resolve());
    });
  }

  // Clean up zip
  try { fs.unlinkSync(zipPath); } catch(_) {}

  // Verify
  const adbExe = bundledAdbPath();
  if (!fs.existsSync(adbExe)) throw new Error('Extraction failed — adb.exe not found after extract');
  onProgress && onProgress('ADB tools ready!');
  return adbExe;
}

// ── Run adb command ───────────────────────────────────────────────────────────
function adbExec(args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const adbPath = findAdb() || 'adb';
    execFile(adbPath, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error((stderr || err.message).trim()));
      resolve((stdout || '').trim());
    });
  });
}

// ── Connect to TV ─────────────────────────────────────────────────────────────
async function connectToDevice(host, port = 5555) {
  const out = await adbExec(['connect', `${host}:${port}`], 10000);
  if (/connected to|already connected/i.test(out)) return out;
  throw new Error(out || 'adb connect failed');
}

// ── Shell command ─────────────────────────────────────────────────────────────
async function shellWithAuth(host, cmd, timeoutMs = 10000) {
  await connectToDevice(host);
  return adbExec(['-s', `${host}:5555`, 'shell', cmd], timeoutMs);
}

// ── App packages ──────────────────────────────────────────────────────────────
const APP_PACKAGES = {
  youtube : 'com.google.android.youtube.tv',
  netflix : 'com.netflix.ninja',
  spotify : 'com.spotify.tv.android',
  prime   : 'com.amazon.amazonvideo.livingroom',
};

async function openYouTube(host, videoId) {
  await connectToDevice(host);
  return adbExec(['-s', `${host}:5555`, 'shell',
    `am start -a android.intent.action.VIEW -d "https://www.youtube.com/watch?v=${videoId}"`], 8000);
}

module.exports = { findAdb, isAdbAvailable, downloadAdb, connectToDevice, shellWithAuth, openYouTube, APP_PACKAGES };
