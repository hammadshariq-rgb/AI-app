const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'licenses.json');

function load() {
  if (!fs.existsSync(DB_PATH)) return {};
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function save(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function makeLicenseKey() {
  const part = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `JARVIS-${part()}-${part()}-${part()}`;
}

// Issue (or reuse) a license key for a given Stripe customer/subscription.
function issueLicense({ customerId, subscriptionId, status }) {
  const db = load();
  let key = Object.keys(db).find((k) => db[k].customerId === customerId);
  if (!key) key = makeLicenseKey();
  db[key] = { customerId, subscriptionId, status, updatedAt: Date.now() };
  save(db);
  return key;
}

function setStatusBySubscription(subscriptionId, status) {
  const db = load();
  for (const key of Object.keys(db)) {
    if (db[key].subscriptionId === subscriptionId) {
      db[key].status = status;
      db[key].updatedAt = Date.now();
    }
  }
  save(db);
}

function isActive(licenseKey) {
  const db = load();
  const entry = db[licenseKey];
  return !!entry && entry.status === 'active';
}

module.exports = { issueLicense, setStatusBySubscription, isActive };
