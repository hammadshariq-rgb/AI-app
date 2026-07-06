const fetch = require('node-fetch');

const SERVER = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';

async function checkSubscription(licenseKey) {
  if (!licenseKey) return false;
  try {
    const res = await fetch(`${SERVER}/license/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.active;
  } catch {
    return false; // server unreachable -> fail closed
  }
}

module.exports = { checkSubscription };
