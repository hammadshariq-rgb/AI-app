// Where a URL may point. Anything an outside party can influence (a pasted link,
// something the AI read on a page, a redirect) must not reach this machine, its
// network or a cloud metadata service: that is server-side request forgery.
// Hostnames are checked when they are resolved, not just beforehand, so a name
// that changes its answer between the check and the request is still refused.
const net = require('net');
const dns = require('dns');
const http = require('http');
const https = require('https');

const blocked = new net.BlockList();
for (const [a, b] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(a, b, 'ipv4');
for (const [a, b] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96]]) blocked.addSubnet(a, b, 'ipv6');

function privateIp(ip) {
  const s = String(ip).replace(/^\[|\]$/g, '').toLowerCase();
  const kind = net.isIP(s);
  if (!kind) return false;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) {
    const [hi, lo] = s.slice(7).split(':').map((h) => parseInt(h, 16));
    return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
  }
  return blocked.check(s, kind === 6 ? 'ipv6' : 'ipv4');
}

// Checks needing no network. Returns the parsed URL, or null if refused.
function publicUrl(raw, { httpsOnly = false } = {}) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (_) { return null; }
  if (u.protocol !== 'https:' && (httpsOnly || u.protocol !== 'http:')) return null;
  if (u.username || u.password) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || /\.(?:localhost|local|internal|intranet|lan|home|corp)$/.test(host) || !/[.:]/.test(host)) return null;
  if (host === 'metadata.google.internal') return null;
  if (privateIp(host)) return null;
  return u;
}

// Every address the name resolves to must be public.
async function resolvesPublic(raw, opts) {
  const u = publicUrl(raw, opts);
  if (!u) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return true;
  try {
    const all = await dns.promises.lookup(host, { all: true });
    return all.length > 0 && !all.some((a) => privateIp(a.address));
  } catch (_) { return false; }
}

function guardedLookup(host, options, cb) {
  const opts = typeof options === 'function' ? {} : options;
  const done = typeof options === 'function' ? options : cb;
  dns.lookup(host, { ...opts, all: true }, (err, list) => {
    if (err) return done(err);
    if (!list.length || list.some((a) => privateIp(a.address))) {
      const e = new Error('That address is not allowed.'); e.code = 'EBLOCKEDHOST';
      return done(e);
    }
    if (opts.all) return done(null, list);
    done(null, list[0].address, list[0].family);
  });
}
const agents = { 'http:': new http.Agent({ lookup: guardedLookup }), 'https:': new https.Agent({ lookup: guardedLookup }) };

// fetch, limited to public addresses, re-checking each redirect itself.
async function safeFetch(fetchFn, raw, options = {}, allow = null) {
  let url = String(raw);
  for (let hop = 0; hop <= 5; hop++) {
    const trusted = allow && allow(url);
    if (!trusted && !publicUrl(url)) throw new Error('That address is not allowed.');
    const res = await fetchFn(url, { ...options, redirect: 'manual', ...(trusted ? {} : { agent: agents[new URL(url).protocol] }) });
    if (res.status < 300 || res.status >= 400 || !res.headers.get('location')) return res;
    url = new URL(res.headers.get('location'), url).toString();
  }
  throw new Error('Too many redirects.');
}

module.exports = { publicUrl, resolvesPublic, safeFetch, privateIp };
