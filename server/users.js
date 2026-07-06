const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, 'users.json');

function load() {
  if (!fs.existsSync(DB)) return [];
  return JSON.parse(fs.readFileSync(DB, 'utf8'));
}
function save(users) {
  fs.writeFileSync(DB, JSON.stringify(users, null, 2));
}

function findByEmail(email) {
  return load().find(u => u.email === email.toLowerCase());
}
function findById(id) {
  return load().find(u => u.id === id);
}
function findByGoogleId(googleId) {
  return load().find(u => u.googleId === googleId);
}

function create({ email, passwordHash, googleId, name, avatarUrl }) {
  const users = load();
  const user = {
    id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    email: email ? email.toLowerCase() : null,
    passwordHash: passwordHash || null,
    googleId: googleId || null,
    name: name || '',
    avatarUrl: avatarUrl || null,
    subscriptionStatus: 'inactive',
    stripeCustomerId: null,
    subscriptionId: null,
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
  };
  users.push(user);
  save(users);
  return user;
}

function update(id, fields) {
  const users = load();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return null;
  Object.assign(users[idx], fields);
  save(users);
  return users[idx];
}

function setSubscription(stripeCustomerId, subscriptionId, status) {
  const users = load();
  const user = users.find(u => u.stripeCustomerId === stripeCustomerId);
  if (!user) return null;
  user.subscriptionStatus = status;
  user.subscriptionId = subscriptionId;
  save(users);
  return user;
}

function findByStripeCustomer(stripeCustomerId) {
  return load().find(u => u.stripeCustomerId === stripeCustomerId);
}

module.exports = { findByEmail, findById, findByGoogleId, findByStripeCustomer, create, update, setSubscription };
