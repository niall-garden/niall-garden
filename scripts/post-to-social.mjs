// /scripts/post-to-social.mjs
// Node 18+ (ESM)
// Autoposts Quartz posts tagged 'socials' to Mastodon & Bluesky

import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import fetch from 'node-fetch';
import { BskyAgent } from '@atproto/api';

const CONTENT_DIR = 'content';
const LAST_POST_FILE = 'data/last-social-post.json';

// Helpers
const parseISO = s => (s ? new Date(s) : null);

async function readLastPosted() {
  try {
    const txt = await fs.readFile(LAST_POST_FILE, 'utf8');
    const json = JSON.parse(txt);
    return json.lastPosted || null;
  } catch {
    return null;
  }
}

async function writeLastPosted(dateIso) {
  await fs.mkdir(path.dirname(LAST_POST_FILE), { recursive: true });
  await fs.writeFile(
    LAST_POST_FILE,
    JSON.stringify({ lastPosted: dateIso }, null, 2),
    'utf8'
  );
}

async function collectMdFiles(dir) {
  const results = [];
  async function walk(d) {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith('.md')) results.push(p);
    }
  }
  await walk(dir);
  return results;
}

function isoDateFromFM(data) {
  if (!data.date) return null;
  const dt = new Date(data.date);
  if (isNaN(dt)) return null;
  return dt.toISOString();
}

function markdownToPlain(md) {
  let txt = md;
  txt = txt.replace(/^---[\s\S]*?---\n/, '');
  txt = txt.replace(/\*\*(.*?)\*\*/gs, '$1');
  txt = txt.replace(/__(.*?)__/gs, '$1');
  txt = txt.replace(/_(.*?)_/gs, '*$1*');
  txt = txt.replace(/^#+\s*(.*)/gm, '$1');
  txt = txt.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1'); // convert links to plain text
  txt = txt.replace(/!\[.*?\]\(.*?\)/g, ''); // remove images
  txt = txt.replace(/\n{3,}/g, '\n\n');
  return txt.trim();
}

// Mastodon post with threading
async function postToMastodon(baseUrl, token, text, socialPreview = true, postLink = '') {
  const chunks = [];

  if (socialPreview && text.length + postLink.length + 1 > 1000) {
    // split long post into 1000-char chunks
    let remaining = text;
    while (remaining.length > 0) {
      let chunk = remaining.slice(0, 1000 - 1);
      if (remaining.length > 1000) {
        const lastSpace = chunk.lastIndexOf(' ');
        if (lastSpace > 0) chunk = chunk.slice(0, lastSpace);
      }
      chunks.push(chunk);
      remaining = remaining.slice(chunk.length).trim();
    }
    chunks[0] = `${chunks[0]} ${postLink}`;
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${postLink}`;
  } else {
    // full post fits, just append link
    chunks.push(`${text}\n${postLink}`);
  }

  let replyId = null;
  for (let i = 0; i < chunks.length; i++) {
    const status = chunks[i];
    const body = { status };
    if (replyId) body.in_reply_to_id = replyId;
    const res = await fetch(new URL('/api/v1/statuses', baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Mastodon post failed: ${res.status} ${txt}`);
    }
    const json = await res.json();
    replyId = json.id;
    console.log(`Mastodon posted chunk ${i + 1}/${chunks.length}, id:`, json.id);
  }
}

// Bluesky post
async function postToBluesky(username, appPass, text, socialPreview = true, postLink = '') {
  const agent = new BskyAgent({ service: 'https://bsky.social' });
  await agent.login({ identifier: username, password: appPass });

  const plainText = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1'); // strip markdown links
  const MAX_LEN = 300;
  let finalText;

  if (plainText.length > MAX_LEN && socialPreview) {
    const truncated = plainText.slice(0, MAX_LEN - 12).trim(); // leave space for " Read more:"
    finalText = `${truncated} Read more: ${postLink}`;
  } else {
    finalText = `${plainText}\n${postLink}`;
  }

  const res = await agent.post({ text: finalText });
  console.log('Bluesky posted:', res.uri || '(no uri returned)');
}

// Main
async function main() {
  console.log('Autopost: starting');

  const mastodonBase = process.env.MASTODON_BASE || null;
  const mastodonToken = process.env.MASTODON_TOKEN || null;
  const bskyUser = process.env.BSKY_USERNAME || null;
  const bskyAppPass = process.env.BSKY_APP_PASS || null;

  const lastPostedIso = await readLastPosted();
  console.log('Last posted date:', lastPostedIso || '(none)');

  const mdFiles = await collectMdFiles(CONTENT_DIR);
  if (mdFiles.length === 0) {
    console.log('No markdown files found in', CONTENT_DIR);
    return;
  }

  const posts = [];
  for (const f of mdFiles) {
    const raw = await fs.readFile(f, 'utf8');
    const fm = matter(raw);
    const iso = isoDateFromFM(fm.data);
    const tags = fm.data.tags
      ? Array.isArray(fm.data.tags)
        ? fm.data.tags.map(t => t.toLowerCase())
        : [fm.data.tags.toLowerCase()]
      : [];
    if (!iso || !tags.includes('socials')) continue;
    posts.push({ path: f, dateIso: iso, content: raw });
  }

  if (posts.length === 0) {
    console.log('No new posts tagged socials found.');
    return;
  }

  posts.sort((a, b) => new Date(b.dateIso) - new Date(a.dateIso));
  const newest = posts[0];
  console.log('Newest post for socials:', newest.path, newest.dateIso);

  if (lastPostedIso && new Date(newest.dateIso) <= new Date(lastPostedIso)) {
    console.log('No new posts to publish (already posted). Exiting.');
    return;
  }

  // Front-matter and canonical link
  const raw = newest.content;
  const fm = matter(raw);
  const postLink = `https://niall.garden/${path.basename(newest.path, '.md')}`;
  const socialPreview = fm.data.social_preview !== false; // false disables canonical link

  const plainText = markdownToPlain(raw);

  // Mastodon
  if (mastodonBase && mastodonToken) {
    await postToMastodon(mastodonBase, mastodonToken, plainText, socialPreview, postLink);
  } else {
    console.log('Mastodon credentials missing. Skipping Mastodon.');
  }

  // Bluesky
  if (bskyUser && bskyAppPass) {
    await postToBluesky(bskyUser, bskyAppPass, plainText, socialPreview, postLink);
  } else {
    console.log('Bluesky credentials missing. Skipping Bluesky.');
  }

  await writeLastPosted(newest.dateIso);
  console.log('Updated last-social-post.json to', newest.dateIso);

  console.log('Autopost: finished');
}

main().catch(err => {
  console.error('Fatal error in autopost:', err);
  process.exit(1);
});
