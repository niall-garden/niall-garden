// /scripts/post-to-social.mjs
// Node 18+ (ESM)
// Auto-posts Quartz notes tagged "socials" to Mastodon & Bluesky
// using simple truncation and never republishing old posts.

import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import fetch from 'node-fetch';
import { BskyAgent } from '@atproto/api';

const CONTENT_DIR = 'content';
const LAST_POST_FILE = 'data/last-social-post.json';

// Read last posted ISO timestamp
async function readLastPosted() {
  try {
    const txt = await fs.readFile(LAST_POST_FILE, 'utf8');
    return JSON.parse(txt).lastPosted || null;
  } catch {
    return null;
  }
}

// Save last posted ISO timestamp
async function writeLastPosted(dateIso) {
  await fs.mkdir(path.dirname(LAST_POST_FILE), { recursive: true });
  await fs.writeFile(
    LAST_POST_FILE,
    JSON.stringify({ lastPosted: dateIso }, null, 2),
    'utf8'
  );
}

// Collect all markdown files recursively
async function collectMdFiles(dir) {
  const results = [];
  async function walk(folder) {
    const items = await fs.readdir(folder, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(folder, item.name);
      if (item.isDirectory()) await walk(full);
      else if (item.isFile() && full.endsWith('.md')) results.push(full);
    }
  }
  await walk(dir);
  return results;
}

// Ensure ISO from frontmatter
function isoDateFromFM(data) {
  if (!data.date) return null;
  const dt = new Date(data.date);
  return isNaN(dt) ? null : dt.toISOString();
}

// Very simple markdown → plain text
function markdownToPlain(md) {
  let txt = md;

  // Remove frontmatter if any
  txt = txt.replace(/^---[\s\S]*?---\n/, '');

  // Remove images
  txt = txt.replace(/!\[.*?\]\(.*?\)/g, '');

  // Convert links [txt](url) → txt
  txt = txt.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');

  // Remove bold, keep italics
  txt = txt.replace(/\*\*(.*?)\*\*/g, '$1');
  txt = txt.replace(/__(.*?)__/g, '$1');

  // Normalize italics
  txt = txt.replace(/_(.*?)_/g, '*$1*');

  // Remove headings
  txt = txt.replace(/^#+\s*(.*)/gm, '$1');

  // Collapse triple newlines
  txt = txt.replace(/\n{3,}/g, '\n\n');

  return txt.trim();
}

// --- Simple Mastodon posting (single post only, truncated) ---
async function postToMastodon(baseUrl, token, text, link) {
  const MAX = 1500;

  let finalText = text;
  if (finalText.length > MAX) {
    finalText = finalText.slice(0, MAX - 20).trim() + "…";
  }

  finalText += `\nread more:\n${link}`;

  const body = { status: finalText };

  const res = await fetch(new URL('/api/v1/statuses', baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new Error(`Mastodon post failed: ${res.status} ${await res.text()}`);
  }

  console.log('Mastodon posted successfully.');
}

// --- Simple Bluesky posting (single post only, truncated) ---
async function postToBluesky(username, appPass, text, link) {
  const MAX = 300;

  const agent = new BskyAgent({ service: 'https://bsky.social' });
  await agent.login({ identifier: username, password: appPass });

  let finalText = text;
  if (finalText.length > MAX) {
    finalText = finalText.slice(0, MAX - 20).trim() + "…";
  }

  finalText += `\nread more:\n${link}`;

  const res = await agent.post({ text: finalText });
  console.log('Bluesky posted:', res.uri || '(no uri returned)');
}

// --- MAIN ---
async function main() {
  console.log('Autopost: starting');

  const mastodonBase = process.env.MASTODON_BASE || null;
  const mastodonToken = process.env.MASTODON_TOKEN || null;
  const bskyUser = process.env.BSKY_USERNAME || null;
  const bskyAppPass = process.env.BSKY_APP_PASS || null;

  const lastPostedIso = await readLastPosted();
  console.log('Last posted:', lastPostedIso || '(none)');

  const files = await collectMdFiles(CONTENT_DIR);

  const posts = [];
  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8');
    const fm = matter(raw);
    const iso = isoDateFromFM(fm.data);

    if (!iso) continue;
    const tags = fm.data.tags
      ? (Array.isArray(fm.data.tags) ? fm.data.tags : [fm.data.tags])
      : [];
    if (!tags.map(t => t.toLowerCase()).includes('socials')) continue;

    posts.push({ path: file, dateIso: iso, content: raw });
  }

  if (posts.length === 0) {
    console.log('No posts tagged socials.');
    return;
  }

  posts.sort((a, b) => new Date(b.dateIso) - new Date(a.dateIso));
  const newest = posts[0];

  console.log('Newest social post:', newest.path, newest.dateIso);

  if (lastPostedIso && new Date(newest.dateIso) <= new Date(lastPostedIso)) {
    console.log('No new posts to publish.');
    return;
  }

  const fm = matter(newest.content);
  const postLink = `https://niall.garden/${path.basename(newest.path, '.md')}`;
  const text = markdownToPlain(fm.content);

  if (mastodonBase && mastodonToken) {
    await postToMastodon(mastodonBase, mastodonToken, text, postLink);
  }

  if (bskyUser && bskyAppPass) {
    await postToBluesky(bskyUser, bskyAppPass, text, postLink);
  }

  await writeLastPosted(newest.dateIso);
  console.log('Saved last posted date.');
  console.log('Autopost: finished');
}

main().catch(err => {
  console.error('Fatal error in autopost:', err);
  process.exit(1);
});
