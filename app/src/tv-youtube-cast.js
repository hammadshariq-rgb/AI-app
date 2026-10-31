'use strict';

// Playing a YouTube video over Cast alone, with no debugging access on the TV.
//
// Launching YouTube's cast receiver only gets an empty screen. It is waiting to
// be told what to play, and that goes through YouTube's "lounge": the receiver
// hands over a screen id, the screen id buys a lounge token, and the token opens
// a session that accepts a playlist. It is the same route a phone's cast button
// takes. YouTube does not document it, so callers keep a fallback.

const { Client, Application, JsonController } = require('castv2-client');
const crypto = require('crypto');
const util = require('util');
// node-fetch fails on YouTube's replies here with "Premature close".
const fetch = globalThis.fetch || require('node-fetch');

const APP_ID = '233637DE';
const MDX_NS = 'urn:x-cast:com.google.youtube.mdx';
const LOUNGE = 'https://www.youtube.com/api/lounge';

function YouTubeReceiver(client, session) { Application.apply(this, arguments); this.mdx = this.createController(JsonController, MDX_NS); }
YouTubeReceiver.APP_ID = APP_ID;
util.inherits(YouTubeReceiver, Application);

function screenIdFrom(host, port) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    let finished = false;
    const finish = (err, id) => {
      if (finished) return;
      finished = true;
      clearTimeout(limit);
      try { c.close(); } catch (_) {}
      if (err) reject(err); else resolve(id);
    };
    const limit = setTimeout(() => finish(new Error('The TV did not answer over Cast.')), 15000);
    c.on('error', (e) => finish(e));
    c.connect({ host, port: port || 8009 }, () => {
      c.launch(YouTubeReceiver, (err, app) => {
        if (err) return finish(err);
        app.mdx.on('message', (data) => {
          if (data && data.type === 'mdxSessionStatus' && data.data && data.data.screenId) finish(null, data.data.screenId);
        });
        // The receiver can take a moment to listen after it launches.
        const ask = () => { if (!finished) { app.mdx.send({ type: 'getMdxSessionStatus' }); setTimeout(ask, 1500); } };
        ask();
      });
    });
  });
}

async function loungeToken(screenId) {
  const res = await fetch(`${LOUNGE}/pairing/get_lounge_token_batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ screen_ids: screenId }).toString(),
  });
  if (!res.ok) throw new Error('YouTube refused the TV (' + res.status + ').');
  const body = await res.json();
  const token = body.screens && body.screens[0] && body.screens[0].loungeToken;
  if (!token) throw new Error('YouTube gave no session for this TV.');
  return token;
}

async function playVideo(host, port, videoId, startAt = 0) {
  const token = await loungeToken(await screenIdFrom(host, port));
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'X-YouTube-LoungeId-Token': token };
  const bound = await fetch(`${LOUNGE}/bc/bind?RID=1&VER=8&CVER=1&auth_failure_option=send_error&loungeIdToken=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      device: 'REMOTE_CONTROL',
      id: crypto.randomBytes(13).toString('hex'),
      name: 'Callisto',
      'mdx-version': '3',
      pairing_type: 'cast',
      app: 'android-phone-13.14.55',
    }).toString(),
  });
  const text = await bound.text();
  const sid = (text.match(/"c","(.*?)",""/) || [])[1];
  const gsession = (text.match(/"S","(.*?)"\]/) || [])[1];
  if (!bound.ok || !sid || !gsession) throw new Error('YouTube would not open a session with the TV.');

  const params = new URLSearchParams({ SID: sid, gsessionid: gsession, RID: '2', VER: '8', CVER: '1', auth_failure_option: 'send_error', loungeIdToken: token });
  const res = await fetch(`${LOUNGE}/bc/bind?${params}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      count: '1',
      ofs: '0',
      req0__sc: 'setPlaylist',
      req0_videoId: videoId,
      req0_listId: '',
      req0_currentTime: String(Math.max(0, Math.round(Number(startAt) || 0))),
      req0_currentIndex: '-1',
      req0_audioOnly: 'false',
      req0_params: '',
      req0_count: '1',
    }).toString(),
  });
  if (!res.ok) throw new Error('YouTube would not start the video (' + res.status + ').');
  return true;
}

module.exports = { playVideo };
