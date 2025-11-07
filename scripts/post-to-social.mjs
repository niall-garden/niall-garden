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

// convert markdown to plain text (keep paragraphs, preserve italics, remove bold, headings, links)
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

  // Remove internal wiki-style links [[text]]
  txt = txt.replace(/\[\[.*?\]\]/g, '');

  // Remove images
  txt = txt.replace(/!\[.*?\]\(.*?\)/g, '');

  return txt.trim();
}

// split text into chunks at word boundaries for Mastodon
function chunkText(text, limit) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    let chunk = remaining.slice(0, limit);
    if (remaining.length > limit) {
      const lastSpace = chunk.lastIndexOf(' ');
      if (lastSpace > 0) chunk = chunk.slice(0, lastSpace);
    }
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length).trim();
  }
  return chunks;
}

// Mastodon post
async function postToMastodon(baseUrl, token, text, socialPreview = true, link = '') {
  const chunks = [];
  if (text.length + link.length > 1000) {
    // Split into 1000-char chunks, add link to first & last
    let remaining = text;
    while (remaining.length > 0) {
      let chunk = remaining.slice(0, 1000);
      if (remaining.length > 1000) {
        const lastSpace = chunk.lastIndexOf(' ');
        if (lastSpace > 0) chunk = chunk.slice(0, lastSpace);
      }
      chunks.push(chunk);
      remaining = remaining.slice(chunk.length).trim();
    }
    chunks[0] = `${chunks[0]} ${link}`;
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${link}`;
  } else {
    chunks.push(`${text}\n${link}`);
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
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
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

  const plainText = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');

  const MAX_LEN = 300;
  let finalText;

  if (plainText.length > MAX_LEN && socialPreview) {
    const truncated = plainText.slice(0, MAX_LEN - 12).trim(); 
    finalText = `${truncated} Read more: ${postLink}`;
  } else if (postLink) {
    finalText = `${plainText}\n${postLink}`;
  } else {
    finalText = plainText;
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
  if (!mdFiles.length) return console.log('No markdown files found.');

  const posts = [];
  for (const f of mdFiles) {
    const raw = await fs.readFile(f, 'utf8');
    const fm = matter(raw);
    const iso = isoDateFromFM(fm.data);
    const tags = fm.data.tags
      ? Array.isArray(fm.data.tags) ? fm.data.tags.map(t => t.toLowerCase()) : [fm.data.tags.toLowerCase()]
      : [];
    if (!iso || !tags.includes('socials')) continue;
    posts.push({ path: f, dateIso: iso, content: raw, fm });
  }

  if (!posts.length) return console.log('No new posts tagged socials found.');

  posts.sort((a, b) => new Date(b.dateIso) - new Date(a.dateIso));
  const newest = posts[0];
  console.log('Newest post for socials:', newest.path, newest.dateIso);

  if (lastPostedIso && new Date(newest.dateIso) <= new Date(lastPostedIso)) {
    console.log('No new posts to publish (already posted). Exiting.');
    return;
  }

  const fm = newest.fm;
  const rawText = newest.content;
  const postLink = fm.data.social_no_link ? '' : `https://niall.garden/${path.basename(newest.path, '.md')}`;
  const socialPreview = fm.data.social_preview !== false;

  const plainText = markdownToPlain(rawText);

  // Mastodon
  if (mastodonBase && mastodonToken) {
    await postToMastodon(mastodonBase, mastodonToken, plainText, socialPreview, postLink);
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
