const { exec } = require('child_process');
const { Notification, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLATFORM = process.platform; // 'win32' | 'darwin' | 'linux'
const IS_WIN   = PLATFORM === 'win32';
const IS_MAC   = PLATFORM === 'darwin';
const IS_LINUX = PLATFORM === 'linux';

// ─── URI SCHEMES (work on all platforms) ─────────────────────────────────────
// These are handled by the OS — Windows Store, macOS URL handlers, Linux xdg-open
const URI_SCHEMES = {
  whatsapp:          'whatsapp:',
  discord:           'discord:',
  telegram:          'tg:',
  skype:             'skype:',
  slack:             'slack:',
  signal:            'sgnl:',
  snapchat:          'snapchat:',
  viber:             'viber:',
  line:              'line:',
  instagram:         'instagram:',
  tiktok:            'tiktok:',
  spotify:           'spotify:',
  zoom:              'zoommtg:',
  'apple music':     'music:',
  facetime:          'facetime:',
  imessage:          'imessage:',
  // Windows-only Store apps (harmless to define; only called on Win)
  teams:             'msteams:',
  'microsoft teams': 'msteams:',
  netflix:           'netflix:',
  xbox:              'xbox:',
  photos:            IS_WIN ? 'ms-photos:' : 'photos:',
  settings:          IS_WIN ? 'ms-settings:' : (IS_MAC ? 'x-apple.systempreferences:' : ''),
  mail:              'mailto:',
  calendar:          IS_WIN ? 'outlookcal:' : 'webcal:',
  onenote:           'onenote:',
};

// ─── NATIVE APP NAMES per platform ────────────────────────────────────────────

// Windows: exe filenames launched via `start`
const WIN_EXES = {
  notepad:              'notepad.exe',
  calculator:           'calc.exe',
  explorer:             'explorer.exe',
  chrome:               'chrome.exe',
  edge:                 'msedge.exe',
  firefox:              'firefox.exe',
  paint:                'mspaint.exe',
  word:                 'winword.exe',
  excel:                'excel.exe',
  powerpoint:           'powerpnt.exe',
  vlc:                  'vlc.exe',
  obs:                  'obs64.exe',
  steam:                'steam.exe',
  vscode:               'code.exe',
  'visual studio code': 'code.exe',
  cmd:                  'cmd.exe',
  terminal:             'wt.exe',
  powershell:           'powershell.exe',
  'windows terminal':   'wt.exe',
};

// macOS: app bundle names launched via `open -a`
const MAC_APPS = {
  chrome:               'Google Chrome',
  firefox:              'Firefox',
  safari:               'Safari',
  edge:                 'Microsoft Edge',
  terminal:             'Terminal',
  iterm:                'iTerm',
  iterm2:               'iTerm',
  finder:               'Finder',
  calculator:           'Calculator',
  calendar:             'Calendar',
  mail:                 'Mail',
  notes:                'Notes',
  reminders:            'Reminders',
  maps:                 'Maps',
  music:                'Music',
  'apple music':        'Music',
  podcasts:             'Podcasts',
  photos:               'Photos',
  imovie:               'iMovie',
  garageband:           'GarageBand',
  xcode:                'Xcode',
  vscode:               'Visual Studio Code',
  'visual studio code': 'Visual Studio Code',
  word:                 'Microsoft Word',
  excel:                'Microsoft Excel',
  powerpoint:           'Microsoft PowerPoint',
  teams:                'Microsoft Teams',
  'microsoft teams':    'Microsoft Teams',
  zoom:                 'zoom.us',
  slack:                'Slack',
  discord:              'Discord',
  spotify:              'Spotify',
  whatsapp:             'WhatsApp',
  telegram:             'Telegram',
  signal:               'Signal',
  skype:                'Skype',
  vlc:                  'VLC',
  obs:                  'OBS',
  steam:                'Steam',
  netflix:              'Netflix',
  facetime:             'FaceTime',
  messages:             'Messages',
  imessage:             'Messages',
  settings:             'System Preferences',
  'system preferences': 'System Preferences',
  'system settings':    'System Settings',
};

// Linux: executable/command names
const LINUX_CMDS = {
  chrome:               'google-chrome',
  'google chrome':      'google-chrome',
  firefox:              'firefox',
  terminal:             'x-terminal-emulator',
  'file manager':       'xdg-open .',
  calculator:           'gnome-calculator',
  vscode:               'code',
  'visual studio code': 'code',
  vlc:                  'vlc',
  obs:                  'obs',
  steam:                'steam',
  spotify:              'spotify',
  slack:                'slack',
  discord:              'discord',
  zoom:                 'zoom',
  teams:                'teams',
  'microsoft teams':    'teams',
  skype:                'skype',
};

// ─── WEB FALLBACKS ────────────────────────────────────────────────────────────
// Used when the desktop app isn't installed
const BROWSER_FALLBACKS = {
  instagram:         'https://www.instagram.com/',
  whatsapp:          'https://web.whatsapp.com/',
  telegram:          'https://web.telegram.org/',
  discord:           'https://discord.com/app',
  snapchat:          'https://web.snapchat.com/',
  tiktok:            'https://www.tiktok.com/',
  twitter:           'https://twitter.com/',
  x:                 'https://x.com/',
  facebook:          'https://www.facebook.com/',
  messenger:         'https://www.messenger.com/',
  spotify:           'https://open.spotify.com/',
  netflix:           'https://www.netflix.com/',
  youtube:           'https://www.youtube.com/',
  slack:             'https://app.slack.com/',
  teams:             'https://teams.microsoft.com/',
  'microsoft teams': 'https://teams.microsoft.com/',
  zoom:              'https://zoom.us/join',
  skype:             'https://web.skype.com/',
  signal:            'https://signal.org/download/',
  viber:             'https://account.viber.com/en/',
  line:              'https://line.me/en/',
  reddit:            'https://www.reddit.com/',
  twitch:            'https://www.twitch.tv/',
  pinterest:         'https://www.pinterest.com/',
  linkedin:          'https://www.linkedin.com/',
  'apple music':     'https://music.apple.com/',
  'youtube music':   'https://music.youtube.com/',
  'amazon music':    'https://music.amazon.com/',
  deezer:            'https://www.deezer.com/',
  tidal:             'https://tidal.com/',
};

// ─── CHROME PATHS per platform ────────────────────────────────────────────────
function getChromeCommands(url) {
  const safe = url.replace(/"/g, '%22');
  if (IS_WIN) {
    return [
      `start "" chrome "${safe}"`,
      `start "" "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "${safe}"`,
      `start "" "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" "${safe}"`,
      `start "" "${os.homedir()}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe" "${safe}"`,
    ];
  }
  if (IS_MAC) {
    return [
      `open -a "Google Chrome" "${safe}"`,
      `open -a "Chromium" "${safe}"`,
      `/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome "${safe}"`,
    ];
  }
  // Linux
  return [
    `google-chrome "${safe}"`,
    `google-chrome-stable "${safe}"`,
    `chromium-browser "${safe}"`,
    `chromium "${safe}"`,
    `xdg-open "${safe}"`,
  ];
}

function openInChrome(url) {
  return new Promise((resolve) => {
    const cmds = getChromeCommands(url);
    const tryNext = (idx) => {
      if (idx >= cmds.length) {
        shell.openExternal(url).then(resolve).catch(resolve);
        return;
      }
      exec(cmds[idx], (err) => {
        if (err) tryNext(idx + 1);
        else resolve();
      });
    };
    tryNext(0);
  });
}

// ─── LAUNCH APP ───────────────────────────────────────────────────────────────
function launchApp(name) {
  return new Promise((resolve) => {
    const lower = name.toLowerCase().trim();

    // 1. Try URI scheme — works cross-platform via the OS default handler
    const uri = URI_SCHEMES[lower];
    if (uri) {
      shell.openExternal(uri).then(() => resolve(true)).catch(() => {
        const web = BROWSER_FALLBACKS[lower];
        if (web) openInChrome(web).then(() => resolve(false)).catch(() => resolve(false));
        else resolve(false);
      });
      return;
    }

    if (IS_WIN) {
      // Windows path: exe → PowerShell Get-StartApps → web fallback
      const exe = WIN_EXES[lower];
      if (exe) {
        exec(`start "" "${exe}"`, (err) => {
          if (!err) { resolve(true); return; }
          exec(`start ${exe}`, () => resolve(true));
        });
        return;
      }
      const ps = `powershell -Command "Get-StartApps | Where-Object { $_.Name -like '*${name}*' } | Select-Object -First 1 -ExpandProperty AppID"`;
      exec(ps, (err, stdout) => {
        const appId = (stdout || '').trim();
        if (!err && appId) {
          exec(`start shell:AppsFolder\\${appId}`, () => resolve(true));
        } else {
          const web = BROWSER_FALLBACKS[lower];
          if (web) { openInChrome(web).then(() => resolve(false)).catch(() => resolve(false)); return; }
          exec(`start "" "${name}"`, (err2) => {
            if (err2) exec(`start ${name}`, () => resolve(false));
            else resolve(true);
          });
        }
      });
      return;
    }

    if (IS_MAC) {
      // macOS: open -a "App Name" → Spotlight mdfind → web fallback
      const appName = MAC_APPS[lower] || name;
      exec(`open -a "${appName}"`, (err) => {
        if (!err) { resolve(true); return; }
        // Try Spotlight to find by name
        exec(`mdfind "kMDItemKind == 'Application' && kMDItemDisplayName == '${name}*'"`, (e2, stdout2) => {
          const appPath = (stdout2 || '').trim().split('\n')[0];
          if (!e2 && appPath) {
            exec(`open "${appPath}"`, () => resolve(true));
          } else {
            const web = BROWSER_FALLBACKS[lower];
            if (web) { openInChrome(web).then(() => resolve(false)).catch(() => resolve(false)); return; }
            // Last resort: try open with the raw name
            exec(`open -a "${name}"`, () => resolve(false));
          }
        });
      });
      return;
    }

    // Linux: known command → which → xdg-open → web fallback
    const cmd = LINUX_CMDS[lower];
    if (cmd) {
      exec(cmd, (err) => {
        if (!err) { resolve(true); return; }
        const web = BROWSER_FALLBACKS[lower];
        if (web) openInChrome(web).then(() => resolve(false)).catch(() => resolve(false));
        else resolve(false);
      });
      return;
    }
    // Try `which` to find the binary
    exec(`which "${name}"`, (err, stdout) => {
      const bin = (stdout || '').trim();
      if (!err && bin) {
        exec(`"${bin}"`, () => resolve(true));
      } else {
        // Try xdg-open (opens default handler)
        exec(`xdg-open "${name}"`, (e2) => {
          if (!e2) { resolve(true); return; }
          const web = BROWSER_FALLBACKS[lower];
          if (web) openInChrome(web).then(() => resolve(false)).catch(() => resolve(false));
          else resolve(false);
        });
      }
    });
  });
}

// ─── FILE MANAGER ─────────────────────────────────────────────────────────────
function openFileManager(folderPath) {
  if (IS_WIN)   exec(folderPath ? `explorer.exe "${folderPath}"` : 'explorer.exe');
  else if (IS_MAC) exec(folderPath ? `open "${folderPath}"` : 'open ~');
  else          exec(folderPath ? `xdg-open "${folderPath}"` : 'xdg-open ~');
}

// ─── CONTACT LOOKUP ───────────────────────────────────────────────────────────
function lookupSystemContact(name) {
  return new Promise((resolve) => {
    if (IS_WIN) {
      const ps = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.ApplicationModel.Contacts.ContactManager,Windows.ApplicationModel,ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
$storeOp = [Windows.ApplicationModel.Contacts.ContactManager]::RequestStoreAsync(1)
$store = $asTask.MakeGenericMethod([Windows.ApplicationModel.Contacts.ContactStore]).Invoke($null, @($storeOp))
$store.Wait(); $store = $store.Result
$findOp = $store.FindContactsAsync("${name.replace(/"/g, '')}")
$contacts = $asTask.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.ApplicationModel.Contacts.Contact]]).Invoke($null, @($findOp))
$contacts.Wait()
$contact = $contacts.Result | Select-Object -First 1
if ($contact) { $contact.Phones | Select-Object -First 1 -ExpandProperty Number }`;
      exec(`powershell -NoProfile -Command "${ps.replace(/\n/g, ' ')}"`, (err, stdout) => {
        resolve((stdout || '').trim().replace(/\s/g, '') || null);
      });
    } else if (IS_MAC) {
      // Use osascript (AppleScript) to look up in macOS Contacts
      const script = `
tell application "Contacts"
  set matchList to (every person whose name contains "${name.replace(/"/g, '')}")
  if matchList is not {} then
    set p to item 1 of matchList
    if (count of phones of p) > 0 then
      return value of item 1 of phones of p
    end if
  end if
  return ""
end tell`;
      exec(`osascript -e '${script.replace(/\n/g, '\n')}'`, (err, stdout) => {
        resolve((stdout || '').trim() || null);
      });
    } else {
      // Linux: no standard contacts API — return null
      resolve(null);
    }
  });
}

// ─── CHAT & CALL URL BUILDERS ────────────────────────────────────────────────
function buildChatUrl(platform, contact) {
  switch (platform) {
    case 'whatsapp': {
      const phone = contact.replace(/[^+\d]/g, '');
      return phone.length >= 7 ? `whatsapp://send?phone=${phone}` : 'whatsapp:';
    }
    case 'telegram':  return contact ? `tg://resolve?domain=${contact}` : 'tg:';
    case 'discord':   return 'discord:';
    case 'instagram': return 'instagram:';
    case 'messenger':
    case 'facebook':  return contact ? `https://www.messenger.com/t/${contact}` : 'https://www.messenger.com/';
    case 'twitter':
    case 'x':         return contact ? `https://x.com/messages/compose?recipient_id=${contact}` : 'https://x.com/messages';
    case 'skype':     return contact ? `skype:${contact}?chat` : 'skype:';
    case 'slack':     return 'slack:';
    case 'signal':    return contact ? `sgnl://signal.me/#p/${contact}` : 'sgnl:';
    case 'snapchat':  return contact ? `snapchat://add/${contact}` : 'snapchat:';
    case 'viber':     return contact ? `viber://chat?number=${contact.replace(/[^+\d]/g, '')}` : 'viber:';
    case 'line':      return contact ? `line://ti/p/${contact}` : 'line:';
    case 'teams':
    case 'microsoft teams':
      return contact ? `msteams://teams.microsoft.com/l/call/0/0?users=${contact}` : 'msteams:';
    case 'zoom':      return contact ? `zoommtg://zoom.us/join?confno=${contact}` : 'zoommtg:zoom.us/start';
    case 'facetime':  return contact ? `facetime:${contact}` : 'facetime:';
    case 'imessage':
    case 'messages':  return contact ? `imessage:${contact}` : 'imessage:';
    default:          return null;
  }
}

function buildCallUrl(platform) {
  switch (platform) {
    case 'whatsapp':      return 'whatsapp:';
    case 'instagram':     return 'instagram:';
    case 'telegram':      return 'tg:';
    case 'discord':       return 'discord:';
    case 'skype':         return 'skype:';
    case 'signal':        return 'sgnl:';
    case 'viber':         return 'viber:';
    case 'snapchat':      return 'snapchat:';
    case 'messenger':
    case 'facebook':      return 'https://www.messenger.com/';
    case 'facetime':      return 'facetime:';
    case 'imessage':
    case 'messages':      return 'imessage:';
    case 'teams':
    case 'microsoft teams': return 'msteams:';
    case 'zoom':          return 'zoommtg:zoom.us/start';
    case 'line':          return 'line:';
    default:              return null;
  }
}

function openUrl(url, platformFallback) {
  return new Promise((resolve) => {
    if (!url) { launchApp(platformFallback || '').then(resolve); return; }
    if (url.startsWith('http')) { openInChrome(url).then(resolve); return; }
    shell.openExternal(url).then(() => resolve()).catch(() => {
      const web = platformFallback && BROWSER_FALLBACKS[platformFallback];
      if (web) openInChrome(web).then(resolve).catch(resolve);
      else launchApp(platformFallback || url).then(resolve);
    });
  });
}

function openChat(platform, contact) {
  return new Promise((resolve) => {
    const url = buildChatUrl(platform, contact);
    openUrl(url, platform).then(resolve);
  });
}

async function makeCall(platform, contactName) {
  if ((platform === 'whatsapp' || platform === 'viber' || platform === 'facetime') && contactName) {
    const number = await lookupSystemContact(contactName);
    if (number) {
      const clean = number.replace(/[^+\d]/g, '');
      const urlMap = {
        whatsapp: `whatsapp://call?phone=${clean}`,
        viber:    `viber://call?number=${clean}`,
        facetime: `facetime:${clean}`,
      };
      return new Promise((resolve) => shell.openExternal(urlMap[platform]).then(resolve).catch(resolve));
    }
  }
  const url = buildCallUrl(platform);
  return new Promise((resolve) => openUrl(url, platform).then(resolve));
}

// ─── FILE SEARCH ROOTS ────────────────────────────────────────────────────────
function getSearchRoots() {
  const home = os.homedir();
  const roots = [
    home,
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
  ];
  if (IS_WIN) {
    // Add any OneDrive folders found in home
    try {
      fs.readdirSync(home, { withFileTypes: true }).forEach((e) => {
        if (e.isDirectory() && e.name.toLowerCase().startsWith('onedrive')) {
          const od = path.join(home, e.name);
          roots.push(od, path.join(od, 'Desktop'), path.join(od, 'Documents'), path.join(od, 'Downloads'));
        }
      });
    } catch (_) {}
  }
  if (IS_MAC) {
    roots.push(path.join(home, 'iCloud Drive'), path.join(home, 'Library', 'Mobile Documents'));
  }
  return roots;
}

function findFolder(name) {
  const target = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const root of getSearchRoots()) {
    if (!fs.existsSync(root)) continue;
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const clean = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (clean.includes(target) || target.includes(clean.slice(0, 4))) {
          return path.join(root, entry.name);
        }
      }
    } catch (_) {}
  }
  return null;
}

function readFileContent(filePath) {
  const MAX = 50 * 1024;
  const textExts = ['.txt', '.md', '.js', '.ts', '.py', '.json', '.csv', '.html', '.css', '.xml', '.log', '.ini', '.cfg', '.yaml', '.yml', '.java', '.c', '.cpp', '.h', '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt'];
  if (!textExts.includes(path.extname(filePath).toLowerCase())) return null;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX) return fs.readFileSync(filePath, 'utf8').slice(0, MAX) + '\n...[file truncated]';
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) { return null; }
}

// ─── MUSIC ────────────────────────────────────────────────────────────────────
function openMusicUri(uri, web) {
  return new Promise((resolve) => {
    if (IS_WIN) {
      exec(`start "" "${uri}"`, (err) => {
        if (err) openInChrome(web).then(resolve).catch(resolve);
        else resolve();
      });
    } else if (IS_MAC) {
      // On Mac, spotify: URIs work natively; open command handles them
      exec(`open "${uri}"`, (err) => {
        if (err) openInChrome(web).then(resolve).catch(resolve);
        else resolve();
      });
    } else {
      // Linux: xdg-open handles registered URI schemes
      exec(`xdg-open "${uri}"`, (err) => {
        if (err) openInChrome(web).then(resolve).catch(resolve);
        else resolve();
      });
    }
  });
}

// ─── MAIN COMMAND RUNNER ─────────────────────────────────────────────────────
async function run(action, arg) {
  switch (action) {

    case 'open_url': {
      let url = String(arg).trim();
      // If it looks like a search query (no dots, or explicitly a search), use Google
      if (!url.startsWith('http') && !url.includes('.')) {
        url = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
      } else if (!url.startsWith('http')) {
        url = 'https://' + url;
      }
      await openInChrome(url);
      return { ok: true };
    }

    case 'open_app': {
      const launched = await launchApp(String(arg).trim());
      return { ok: launched };
    }

    case 'open_chat': {
      const parts = String(arg).split('|');
      await openChat((parts[0] || '').toLowerCase().trim(), (parts[1] || '').trim());
      return { ok: true };
    }

    case 'make_call': {
      const parts = String(arg).split('|');
      await makeCall(parts[0].toLowerCase().trim(), parts[1] ? parts[1].trim() : null);
      return { ok: true };
    }

    case 'open_folder': {
      const name = String(arg).trim();
      const found = findFolder(name);
      if (found) {
        shell.openPath(found);
        return { ok: true, path: found };
      }
      openFileManager();
      return { ok: false, error: `Couldn't find a folder named "${name}"` };
    }

    case 'open_file': {
      const nameArg = String(arg).trim();
      if (fs.existsSync(nameArg)) {
        shell.openPath(nameArg);
        return { ok: true, content: readFileContent(nameArg) };
      }
      const target = nameArg.toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const root of getSearchRoots()) {
        if (!fs.existsSync(root)) continue;
        try {
          const entries = fs.readdirSync(root, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) continue;
            const clean = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (clean.includes(target) || target.includes(clean.replace(/\.[^.]+$/, '').slice(0, 6))) {
              const full = path.join(root, entry.name);
              shell.openPath(full);
              return { ok: true, content: readFileContent(full) };
            }
          }
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            try {
              for (const se of fs.readdirSync(path.join(root, entry.name), { withFileTypes: true })) {
                if (se.isDirectory()) continue;
                const clean = se.name.toLowerCase().replace(/[^a-z0-9]/g, '');
                if (clean.includes(target)) {
                  const full = path.join(root, entry.name, se.name);
                  shell.openPath(full);
                  return { ok: true, content: readFileContent(full) };
                }
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
      return { ok: false, error: `Couldn't find a file named "${nameArg}". Try the 📁 button to browse manually.` };
    }

    case 'play_music': {
      const parts = String(arg).split('|');
      const preferredService = (parts[0] || '').trim().toLowerCase();
      const query = (parts[1] || parts[0] || '').trim();
      const q = encodeURIComponent(query);

      const getServiceUrl = (svc) => {
        switch (svc) {
          case 'spotify':       return { uri: `spotify:search:${query}`, web: `https://open.spotify.com/search/${q}` };
          case 'apple music':   return { uri: IS_MAC ? `music://search?term=${q}` : null, web: `https://music.apple.com/search?term=${q}` };
          case 'youtube music': return { uri: null, web: `https://music.youtube.com/search?q=${q}` };
          case 'amazon music':  return { uri: `amzn-music://play?q=${q}`, web: `https://music.amazon.com/search/${q}` };
          case 'deezer':        return { uri: `deezer://search/${query}`, web: `https://www.deezer.com/search/${q}` };
          case 'tidal':         return { uri: `tidal://search?q=${q}`, web: `https://tidal.com/search?q=${q}` };
          default:              return { uri: null, web: `https://www.youtube.com/results?search_query=${q}` };
        }
      };

      const { uri, web } = getServiceUrl(preferredService || 'youtube');
      if (uri) await openMusicUri(uri, web);
      else await openInChrome(web);
      return { ok: true };
    }

    case 'notify': {
      new Notification({ title: 'Assistant', body: String(arg) }).show();
      return { ok: true };
    }

    case 'open_file_dialog':
      return { ok: true };

    default:
      return { ok: false };
  }
}

module.exports = { run, findFolder, readFileContent, makeCall, openChat };
