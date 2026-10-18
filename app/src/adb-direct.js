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
// Loaded only when platform-tools actually needs unzipping. A top-level require
// here once crashed the whole main process at startup when the module was missing
// from the build, silently breaking everything registered after tv-cast.
function loadAdmZip() { return require('adm-zip'); }

// ── Bundled adb location (auto-downloaded into userData) ─────────────────────
// Google publishes platform-tools per OS; the binary is adb.exe only on Windows.
const ADB_BIN = process.platform === 'win32' ? 'adb.exe' : 'adb';
const PLATFORM_TOOLS_OS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';

function bundledAdbDir() {
  return path.join(app.getPath('userData'), 'platform-tools');
}
function bundledAdbPath() {
  return path.join(bundledAdbDir(), ADB_BIN);
}

// ── Find adb.exe: bundled first, then common SDK installs, then PATH ──────────
function findAdb() {
  // 1. Our bundled/downloaded copy
  const bd = bundledAdbPath();
  try { if (fs.existsSync(bd)) return bd; } catch(_) {}

  // 2. Common SDK install locations
  const candidates = [
    path.join(process.env.HOME || '', 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
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
  const PLATFORM_TOOLS_URL = `https://dl.google.com/android/repository/platform-tools-latest-${PLATFORM_TOOLS_OS}.zip`;
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
    const AdmZip = loadAdmZip();
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(app.getPath('userData'), true);
    // zip extracts to platform-tools/ directory — that's exactly what we want
  } catch (e) {
    // adm-zip might not be bundled — fall back to the OS's own unzip
    await new Promise((resolve, reject) => {
      const done = (err) => (err ? reject(err) : resolve());
      if (process.platform === 'win32') {
        // An argument list rather than a shell line with -WindowStyle Hidden,
        // which is one of the patterns antivirus engines flag.
        require('child_process').execFile('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command',
           `Expand-Archive -Path '${zipPath}' -DestinationPath '${app.getPath('userData')}' -Force`],
          { windowsHide: true, timeout: 30000 }, done);
      } else {
        execFile('unzip', ['-o', zipPath, '-d', app.getPath('userData')], { timeout: 30000 }, done);
      }
    });
  }

  // Clean up zip
  try { fs.unlinkSync(zipPath); } catch(_) {}

  // Verify
  const adbExe = bundledAdbPath();
  if (!fs.existsSync(adbExe)) throw new Error('Extraction failed — adb not found after extract');
  // Zip extraction drops the executable bit on macOS and Linux.
  if (process.platform !== 'win32') { try { fs.chmodSync(adbExe, 0o755); } catch (_) {} }
  onProgress && onProgress('ADB tools ready!');
  return adbExe;
}

// ── Run adb command ───────────────────────────────────────────────────────────
// adb proves who it is with a key kept at $HOME/.android/adbkey, and the TV
// remembers that key after you accept "Allow USB debugging?" once. No
// environment was being passed to adb at all, so which HOME it saw depended
// on how the app happened to be launched - and a packaged Mac app started
// from Finder gets a different one from a terminal. A different HOME means a
// different key, a key the TV has never seen, and the prompt again. Every
// time. Pinning it to one directory inside Callisto's own data means the TV
// is asked once and never again.
let _adbEnv = null;
function adbEnv() {
  if (_adbEnv) return _adbEnv;
  const home = path.join(app.getPath('userData'), 'adb-home');
  try { fs.mkdirSync(path.join(home, '.android'), { recursive: true }); } catch (_) {}
  _adbEnv = { ...process.env, HOME: home, USERPROFILE: home, ANDROID_SDK_HOME: home };
  return _adbEnv;
}

// Callisto's own adb server, on a port nothing else uses.
//
// This is the piece that made setting HOME useless on its own. The adb
// command line does not talk to the TV: it talks to a background server on
// port 5037, and if one is ALREADY running - started by Android Studio, by
// another tool, or by Callisto itself before the key moved - that server
// holds the old key and our environment never reaches it. The TV then sees a
// key it has never been shown and asks again, every single launch.
//
// On a port of our own, the first command starts a server with our HOME, and
// every command after that reaches the same one.
const ADB_PORT = '5177';
function adbArgs(args) { return ['-P', ADB_PORT, ...args]; }

function adbExec(args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const adbPath = findAdb() || 'adb';
    execFile(adbPath, adbArgs(args), { timeout: timeoutMs, windowsHide: true, env: adbEnv() }, (err, stdout, stderr) => {
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

// ── Device state: "device" (ready), "unauthorized" (waiting for the user to
// accept the prompt on the TV), "offline", or null when it isn't listed ────────
async function deviceState(host, port = 5555) {
  const out = await adbExec(['devices'], 5000).catch(() => '');
  const line = out.split(/\r?\n/).find((l) => l.startsWith(`${host}:${port}`));
  if (!line) return null;
  return line.split(/\s+/)[1] || null;
}

// ── Screenshot of the TV, as PNG bytes ────────────────────────────────────────
// Some TVs (TCL among them) print debug lines before the image, so cut from the
// PNG signature onward. Apps that protect their video (Netflix) come back black.
function screencap(host, port = 5555) {
  return new Promise((resolve, reject) => {
    const adbPath = findAdb() || 'adb';
    execFile(adbPath, adbArgs(['-s', `${host}:${port}`, 'exec-out', 'screencap', '-p']),
      { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 10000, windowsHide: true, env: adbEnv() },
      (err, stdout) => {
        if (err && !(stdout && stdout.length)) return reject(err);
        const start = stdout.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        if (start < 0) return reject(new Error('No image came back from the TV'));
        resolve(stdout.subarray(start));
      });
  });
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

module.exports = { findAdb, isAdbAvailable, downloadAdb, connectToDevice, shellWithAuth, openYouTube, deviceState, screencap, APP_PACKAGES };
