// /scripts/post-to-social.mjs
// Node 18+ (ESM)
// Simplified autopost for Quartz posts tagged 'socials' to Mastodon & Bluesky

import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import fetch from 'node-fetch';
import { BskyAgent } from '@atproto/api';

const CONTENT_DIR = 'content';
const LAST_POST_FILE = 'data/last-social-post.json';

// helpers
const parseISO = s => (s ? new Date(s) : null);

// read last-posted info
async function readLastPosted() {
  try {
    const txt = await fs.readFile(LAST_POST_FILE, 'utf8');
    const json = JSON.parse(txt);
    return json.lastPosted || null;
  } catch {
    return null;
  }
}

// write last-posted date
async function writeLastPosted(dateIso) {
  await fs.mkdir(path.dirname(LAST_POST_FILE), { recursive: true });
  await fs.writeFile(
    LAST_POST_FILE,
    JSON.stringify({ lastPosted: dateIso }, null, 2),
    'utf8'
  );
}

// recursively collect md files
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

// get ISO date from frontmatter
function isoDateFromFM(data) {
  if (!data.date) return null;
  const dt = new Date(data.date);
  if (isNaN(dt)) return null;
  return dt.toISOString();
}

// convert markdown to plain text (preserve paragraphs, italics, remove bold/headings/links)
function markdownToPlain(md) {
  let txt = md;

  // Remove front-matter if present
  txt = txt.replace(/^---[\s\S]*?---\n/, '');

  // Keep *italics*, remove bold
  txt = txt.replace(/\*\*(.*?)\*\*/gs, '$1');
  txt = txt.replace(/__(.*?)__/gs, '$1');

  // Normalize italics to *
  txt = txt.replace(/_(.*?)_/gs, '*$1*');

  // Remove headings
  txt = txt.replace(/^#+\s*(.*)/gm, '$1');

  // Convert links [text](url) -> text
  txt = txt.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');

  // Remove images
  txt = txt.replace(/!\[.*?\]\(.*?\)/g, '');

  // Trim excess blank lines
  txt = txt.replace(/\n{3,}/g, '\n\n');

  return txt.trim();
}

// Mastodon post (single post, up to 1500 chars)
async function postToMastodon(baseUrl, token, text, link) {
  const LIMIT = 1500;
  let finalText;

  if (text.length > LIMIT) {
    const truncated = text.slice(0, LIMIT - 12).trim(); // leave space for '… read more'
    finalText = `${truncated}… read more: ${link}`;
  } else {
    finalText = `${text}\n${link}`;
  }

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
    const txt = await res.text();
    throw new Error(`Mastodon post failed: ${res.status} ${txt}`);
  }
  const json = await res.json();
  console.log('Mastodon posted, id:', json.id);
}

// Bluesky post (single post, up to 300 graphemes)
async function postToBluesky(username, appPass, text, link) {
  const agent = new BskyAgent({ service: 'https://bsky.social' });
  await agent.login({ identifier: username, password: appPass });

  const MAX_LEN = 300;
  let finalText;

  if (text.length > MAX_LEN) {
    const truncated = text.slice(0, MAX_LEN - 12).trim();
    finalText = `${truncated}… read more: ${link}`;
  } else {
    finalText = `${text}\n${link}`;
  }

  const res = await agent.post({ text: finalText });
  console.log('Bluesky posted:', res.uri || '(no uri returned)');
}

// main
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

  // parse files and filter by socials tag
  const posts = [];
  for (const f of mdFiles) {
    const raw = await fs.readFile(f, 'utf8');
    const fm = matter(raw);
    const iso = isoDateFromFM(fm.data);
    const tags = fm.data.tags
      ? Array.isArray(fm.data.tags) ? fm.data.tags.map(t => t.toLowerCase()) : [fm.data.tags.toLowerCase()]
      : [];
    if (!iso || !tags.includes('socials')) continue;
    posts.push({ path: f, dateIso: iso, content: raw });
  }

  if (posts.length === 0) {
    console.log('No new posts tagged socials found.');
    return;
  }

  // find newest by date
  posts.sort((a, b) => new Date(b.dateIso) - new Date(a.dateIso));
  const newest = posts[0];
  console.log('Newest post for socials:', newest.path, newest.dateIso);

  // skip if already posted
  if (lastPostedIso && new Date(newest.dateIso) <= new Date(lastPostedIso)) {
    console.log('No new posts to publish (already posted). Exiting.');
    return;
  }

  // frontmatter
  const fm = matter(newest.content);
  const postLink = `https://niall.garden/${path.basename(newest.path, '.md')}`;

  const text = markdownToPlain(fm.content);

  // Mastodon
  if (mastodonBase && mastodonToken) {
    await postToMastodon(mastodonBase, mastodonToken, text, postLink);
  }

  // Bluesky
  if (bskyUser && bskyAppPass) {
    await postToBluesky(bskyUser, bskyAppPass, text, postLink);
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
