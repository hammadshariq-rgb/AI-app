// ── Publishing to the customer's own accounts ─────────────────────────────────
// Uploads a video or photo to YouTube, Instagram or TikTok using the tokens the
// customer connected in Callisto. Nothing is ever posted without the customer
// confirming it first — the renderer shows a confirm card and only then calls
// publish().
//
// Each platform takes media differently:
//   YouTube   — resumable upload of the bytes themselves.
//   Instagram — fetches a public URL, so the file is parked on the licence
//               server for an hour (server/media-host.js) and removed after.
//   TikTok    — chunked upload of the bytes. Apps that TikTok hasn't audited can
//               only send to the user's TikTok inbox as a draft, so we fall back
//               to that when a direct post is refused.

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const connectors = require('./connectors');

const SERVER = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';

const MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};

const PLATFORM_NAMES = { youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok' };

function mimeFor(file) { return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'; }
const isVideo = (type) => String(type).startsWith('video/');

// Reads the media for a job: a local file, or a remote URL (a generated video).
async function loadMedia({ filePath, url }) {
  if (filePath) {
    const buf = fs.readFileSync(filePath);
    return { buf, type: mimeFor(filePath), name: path.basename(filePath) };
  }
  if (url && /^file:\/\//i.test(url)) {
    const p = decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
    return { buf: fs.readFileSync(p), type: mimeFor(p), name: path.basename(p) };
  }
  if (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Couldn't download the file (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || (/\.mp4/i.test(url) ? 'video/mp4' : 'image/jpeg');
    return { buf, type: type.split(';')[0].trim(), name: 'media' };
  }
  throw new Error('Nothing to upload.');
}

// Park the bytes on the licence server so a platform can fetch them.
async function hostTemporarily(buf, type, token) {
  const res = await fetch(`${SERVER}/media/temp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ data: buf.toString('base64'), type }),
  });
  const data = await res.json();
  if (!res.ok || !data.url) throw new Error(data.error || 'Could not prepare the file for upload.');
  return data.url;
}

async function unhost(url, token) {
  try {
    const id = url.split('/').pop();
    await fetch(`${SERVER}/media/temp/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  } catch (_) { /* it expires on its own */ }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── YouTube ───────────────────────────────────────────────────────────────────
async function toYouTube({ buf, type }, { title, description, privacy }) {
  const token = await connectors.getYouTubeToken();
  if (!token) throw new Error('YouTube isn’t connected. Connect it in Connectors first.');
  if (!isVideo(type)) throw new Error('YouTube takes videos, not photos.');

  const meta = {
    snippet: { title: (title || 'Callisto video').slice(0, 100), description: (description || '').slice(0, 4800) },
    status: { privacyStatus: privacy || 'private', selfDeclaredMadeForKids: false },
  };
  const start = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Length': String(buf.length),
      'X-Upload-Content-Type': type,
    },
    body: JSON.stringify(meta),
  });
  if (!start.ok) {
    const err = await start.text();
    if (/insufficient (authentication scopes|permission)/i.test(err) || start.status === 401) {
      throw new Error('Reconnect YouTube in Connectors — the current connection doesn’t include permission to upload.');
    }
    if (start.status === 403 && /quota|exceeded/i.test(err)) {
      throw new Error('YouTube’s daily upload quota for this app is used up. Try again tomorrow.');
    }
    if (start.status === 403 && /youtubeSignupRequired|unauthorized/i.test(err)) {
      throw new Error('That Google account has no YouTube channel. Create one, then reconnect.');
    }
    throw new Error(`YouTube refused the upload (${start.status}).`);
  }
  const uploadUrl = start.headers.get('location');
  if (!uploadUrl) throw new Error('YouTube didn’t return an upload address.');

  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': type, 'Content-Length': String(buf.length) }, body: buf });
  const data = await put.json().catch(() => ({}));
  if (!put.ok || !data.id) throw new Error(data.error?.message || 'The upload didn’t finish.');
  const vis = privacy || 'private';
  const note = vis === 'private' ? 'Uploaded as private — publish it when you’re ready.'
    : vis === 'unlisted' ? 'Uploaded as unlisted — only people with the link can watch it.'
    : null;
  return { id: data.id, url: `https://youtu.be/${data.id}`, note };
}

// ── Instagram ─────────────────────────────────────────────────────────────────
async function toInstagram(media, { description }, authToken) {
  const token = await connectors.getInstagramToken();
  if (!token) throw new Error('Instagram isn’t connected. Connect it in Connectors first.');

  const pages = await fetch(`https://graph.facebook.com/v23.0/me/accounts?fields=instagram_business_account,name&access_token=${token}`).then((r) => r.json());
  const igId = pages.data?.find((p) => p.instagram_business_account)?.instagram_business_account?.id;
  if (!igId) throw new Error('No Instagram business account is linked to that Facebook page.');

  const publicUrl = await hostTemporarily(media.buf, media.type, authToken);
  try {
    const body = new URLSearchParams({ access_token: token, caption: (description || '').slice(0, 2200) });
    if (isVideo(media.type)) { body.set('media_type', 'REELS'); body.set('video_url', publicUrl); }
    else body.set('image_url', publicUrl);

    const created = await fetch(`https://graph.facebook.com/v23.0/${igId}/media`, { method: 'POST', body }).then((r) => r.json());
    if (!created.id) throw new Error(created.error?.message || 'Instagram wouldn’t accept the file.');

    // Video needs processing before it can be published.
    if (isVideo(media.type)) {
      for (let i = 0; i < 60; i++) {
        await wait(3000);
        const st = await fetch(`https://graph.facebook.com/v23.0/${created.id}?fields=status_code,status&access_token=${token}`).then((r) => r.json());
        if (st.status_code === 'FINISHED') break;
        if (st.status_code === 'ERROR') throw new Error(st.status || 'Instagram couldn’t process that video.');
        if (i === 59) throw new Error('Instagram is taking too long to process the video.');
      }
    }

    const published = await fetch(`https://graph.facebook.com/v23.0/${igId}/media_publish`, {
      method: 'POST',
      body: new URLSearchParams({ creation_id: created.id, access_token: token }),
    }).then((r) => r.json());
    if (!published.id) throw new Error(published.error?.message || 'Instagram wouldn’t publish the post.');
    return { id: published.id, url: `https://www.instagram.com/p/${published.id}`, note: null };
  } finally {
    await unhost(publicUrl, authToken);
  }
}

// ── Facebook Page ─────────────────────────────────────────────────────────────
// The same Meta login as Instagram, so connecting Instagram covers both. Only a
// Page can be posted to — Meta closed posting to personal profiles years ago.
async function toFacebook(media, { title, description }, authToken) {
  const token = await connectors.getInstagramToken();
  if (!token) throw new Error('Facebook isn’t connected. Connect Instagram in Connectors — it covers your Facebook Page too.');

  const pages = await fetch(`https://graph.facebook.com/v23.0/me/accounts?fields=id,name,access_token&access_token=${token}`).then((r) => r.json());
  const page = pages.data?.[0];
  if (!page?.access_token) throw new Error(pages.error?.message || 'No Facebook Page found on that account.');

  const caption = (description || title || '').slice(0, 5000);
  const publicUrl = await hostTemporarily(media.buf, media.type, authToken);
  try {
    const video = isVideo(media.type);
    const body = new URLSearchParams({ access_token: page.access_token });
    if (video) { body.set('file_url', publicUrl); if (caption) body.set('description', caption); if (title) body.set('title', title); }
    else { body.set('url', publicUrl); if (caption) body.set('caption', caption); }

    const res = await fetch(`https://graph.facebook.com/v23.0/${page.id}/${video ? 'videos' : 'photos'}`, { method: 'POST', body }).then((r) => r.json());
    const id = res.id || res.post_id;
    if (!id) throw new Error(res.error?.message || 'Facebook wouldn’t accept the post.');
    return {
      id,
      url: `https://www.facebook.com/${String(id).includes('_') ? id : `${page.id}/posts/${id}`}`,
      note: video ? 'Facebook may take a minute to finish processing the video.' : null,
    };
  } finally {
    await unhost(publicUrl, authToken);
  }
}

// ── TikTok ────────────────────────────────────────────────────────────────────
async function toTikTok(media, { title, privacy }) {
  const token = await connectors.getTikTokToken();
  if (!token) throw new Error('TikTok isn’t connected. Connect it in Connectors first.');
  if (!isVideo(media.type)) throw new Error('TikTok takes videos, not photos.');

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' };
  const source_info = {
    source: 'FILE_UPLOAD',
    video_size: media.buf.length,
    chunk_size: media.buf.length,
    total_chunk_count: 1,
  };

  // Try a real post first; fall back to the drafts inbox when the app isn't
  // audited for direct posting.
  let init = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      post_info: {
        title: (title || 'Callisto video').slice(0, 150),
        privacy_level: privacy === 'public' ? 'PUBLIC_TO_EVERYONE' : 'SELF_ONLY',
        disable_comment: false, disable_duet: false, disable_stitch: false,
      },
      source_info,
    }),
  }).then((r) => r.json());

  let draft = false;
  if (init.error && init.error.code && init.error.code !== 'ok') {
    init = await fetch('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
      method: 'POST', headers, body: JSON.stringify({ source_info }),
    }).then((r) => r.json());
    draft = true;
  }
  const upload = init.data?.upload_url;
  if (!upload) throw new Error(init.error?.message || 'TikTok wouldn’t start the upload.');

  const put = await fetch(upload, {
    method: 'PUT',
    headers: { 'Content-Type': media.type, 'Content-Range': `bytes 0-${media.buf.length - 1}/${media.buf.length}` },
    body: media.buf,
  });
  if (!put.ok) throw new Error(`TikTok upload failed (${put.status}).`);

  return {
    id: init.data?.publish_id || null,
    url: 'https://www.tiktok.com/',
    note: draft
      ? 'Sent to your TikTok drafts — open the TikTok app to add sounds and post it.'
      : (privacy === 'public' ? null : 'Posted as private on TikTok — make it public in the app when you’re ready.'),
  };
}

// Publishes one item. `platform` is youtube | instagram | facebook | tiktok.
async function publish({ platform, filePath, url, title, description, privacy, authToken }) {
  const name = PLATFORM_NAMES[platform];
  if (!name) throw new Error('That platform isn’t supported yet.');
  const media = await loadMedia({ filePath, url });

  if (platform === 'youtube') return { ...(await toYouTube(media, { title, description, privacy })), platform: name };
  if (platform === 'instagram') return { ...(await toInstagram(media, { description: description || title }, authToken)), platform: name };
  if (platform === 'facebook') return { ...(await toFacebook(media, { title, description }, authToken)), platform: name };
  return { ...(await toTikTok(media, { title, privacy })), platform: name };
}

module.exports = { publish, PLATFORM_NAMES };
