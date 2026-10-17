// Does the "put their app back in front" step work?
//
// Opens Notepad, notes it as the front window, deliberately steals focus with
// an Electron window, then restores and checks Notepad is in front again. This
// is the step that decides whether "write it here" lands in their draft or in
// Callisto.
const { app, BrowserWindow } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
app.setPath('userData', path.join(app.getPath('temp'), 'callisto-focus-test'));

const ps = (cmd) => new Promise((resolve) => {
  execFile('powershell.exe', ['-NonInteractive', '-NoProfile', '-Command', cmd],
    { timeout: 20000 }, (err, out) => resolve(err ? '' : String(out).trim()));
});

const GET_FG = 'Add-Type -Namespace Cal -Name Win -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\'; [Cal.Win]::GetForegroundWindow().ToInt64()';
const TITLE_OF = (h) => 'Add-Type -Namespace Cal -Name T -MemberDefinition \'[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);\'; $sb = New-Object System.Text.StringBuilder 300; [Cal.T]::GetWindowText([IntPtr]' + h + ', $sb, 300) | Out-Null; $sb.ToString()';
const SET_FG = (h) => 'Add-Type -Namespace Cal -Name Fg -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);\'; [Cal.Fg]::SetForegroundWindow([IntPtr]' + h + ') | Out-Null';

app.whenReady().then(async () => {
  if (process.platform !== 'win32') { console.log('windows only'); return app.quit(); }

  execFile('notepad.exe', [], () => {});
  await new Promise((r) => setTimeout(r, 2500));

  let target = await ps(GET_FG);
  for (let i = 0; i < 3 && !target; i++) { await new Promise((r) => setTimeout(r, 800)); target = await ps(GET_FG); }
  const targetTitle = await ps(TITLE_OF(target));
  console.log('front app before : hwnd=' + target + '  "' + targetTitle + '"');
  if (!/notepad|untitled/i.test(targetTitle)) {
    console.log('  (could not get Notepad in front; the rest is still a valid check)');
  }

  // Steal focus, exactly as Callisto's own window would.
  const win = new BrowserWindow({ width: 500, height: 300, show: true, title: 'CallistoFocusTest' });
  await win.loadURL('data:text/html,' + encodeURIComponent('<body style="background:#123;color:#fff">stealing focus</body>'));
  win.focus();
  await new Promise((r) => setTimeout(r, 1200));

  const stolen = await ps(GET_FG);
  console.log('front app after steal: hwnd=' + stolen + '  "' + (await ps(TITLE_OF(stolen))) + '"');
  console.log('focus actually moved : ' + (stolen !== target));

  // The restore step under test.
  await ps(SET_FG(target));
  await new Promise((r) => setTimeout(r, 900));

  const back = await ps(GET_FG);
  const backTitle = await ps(TITLE_OF(back));
  console.log('front app restored   : hwnd=' + back + '  "' + backTitle + '"');
  console.log('');
  console.log(back === target
    ? 'PASS - their app was put back in front, so the paste would land in it'
    : 'FAIL - focus did not return; a paste would go to the wrong window');

  win.destroy();
  await ps('Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force');
  app.quit();
});
