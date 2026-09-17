// Ad-hoc signs the macOS app after packaging.
//
// Apple silicon refuses to launch any binary without a signature, so an unsigned
// arm64 build fails with "app is damaged and can't be opened". We don't have an
// Apple Developer ID certificate yet, so sign with the ad-hoc identity ("-"),
// which satisfies that requirement. Users still see Gatekeeper's "unidentified
// developer" prompt on first launch (right-click → Open) until the app is signed
// with a Developer ID and notarised.
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // A real certificate is configured — electron-builder handles signing itself.
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const entitlements = path.join(__dirname, 'entitlements.mac.plist');
  try {
    execFileSync('codesign', [
      '--force', '--deep', '--sign', '-',
      '--options', 'runtime',
      '--entitlements', entitlements,
      '--timestamp=none',
      appPath,
    ], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
    console.log(`[adhoc-sign] signed ${path.basename(appPath)} (${context.arch === 1 ? 'x64' : 'arm64'})`);
  } catch (err) {
    console.error('[adhoc-sign] failed:', err.message);
    throw err;
  }
};
