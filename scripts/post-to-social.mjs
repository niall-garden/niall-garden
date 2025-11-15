// scripts/post-to-social.mjs
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import fetch from 'node-fetch';
import { BskyAgent } from '@atproto/api';
import GraphemeSplitter from 'grapheme-splitter';

const CONTENT_DIR = 'content';
const LAST_POST_FILE = 'data/last-social-post.json';

// helpers
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
  await fs.writeFile(LAST_POST_FILE, JSON.stringify({ lastPosted: dateIso }, null, 2), 'utf8');
}

// convert markdown to plain text (basic)
function markdownToPlain(md) {
  let txt = md.replace(/^---[\s\S]*?---\n/, '');
  txt = txt.replace(/\*\*(.*?)\*\*/gs, '$1'); 
  txt = txt.replace(/__(.*?)__/gs, '$1'); 
  txt = txt.replace(/_(.*?)_/gs, '*$1*');
  txt = txt.replace(/^#+\s*(.*)/gm, '$1');
  txt = txt.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
  txt = txt.replace(/!\[.*?\]\(.*?\)/g, '');
  txt = txt.replace(/\n{3,}/g, '\n\n');
  return txt.trim();
}

// Mastodon post (1500 chars)
async function postToMastodon(baseUrl, token, text, socialPreview = true, link = '') {
  const LIMIT = 1500;
  const chunks = [];
  if (socialPreview && text.length + link.length > LIMIT) {
    let remaining = text;
    while (remaining.length > 0) {
      let chunk = remaining.slice(0, LIMIT - 1);
      const lastSpace = chunk.lastIndexOf(' ');
      if (lastSpace > 0) chunk = chunk.slice(0, lastSpace);
      chunks.push(chunk);
      remaining = remaining.slice(chunk.length).trim();
    }
    chunks[0] = `${chunks[0]}\n${link}`;
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n${link}`;
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
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Mastodon post failed: ${res.status}`);
    const json = await res.json();
    replyId = json.id;
    console.log(`Mastodon posted chunk ${i + 1}/${chunks.length}, id:`, json.id);
  }
}

// Bluesky post (300 graphemes)
async function postToBluesky(username, appPass, text, socialPreview = true, postLink = '') {
  const agent = new BskyAgent({ service: 'https://bsky.social' });
  await agent.login({ identifier: username, password: appPass });

  const splitter = new GraphemeSplitter();
  const graphemes = splitter.splitGraphemes(text);
  const MAX = 300;
  let finalText = '';

  const footer = socialPreview ? `… read more at:\n${postLink}` : '';
  if (graphemes.length + splitter.countGraphemes(footer) <= MAX) {
    finalText = text + footer;
  } else {
    const allowed = MAX - splitter.countGraphemes(footer);
    finalText = splitter.splitGraphemes(text).slice(0, allowed).join('') + footer;
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

  const mdFiles = await fs.readdir(CONTENT_DIR);
  const posts = [];
  for (const f of mdFiles) {
    if (!f.endsWith('.md')) continue;
    const raw = await fs.readFile(path.join(CONTENT_DIR, f), 'utf8');
    const fm = matter(raw);
    const iso = fm.data.date ? new Date(fm.data.date).toISOString() : null;
    const tags = fm.data.tags ? (Array.isArray(fm.data.tags) ? fm.data.tags.map(t => t.toLowerCase()) : [fm.data.tags.toLowerCase()]) : [];
    if (!iso || !tags.includes('socials')) continue;
    posts.push({ path: f, dateIso: iso, content: raw });
  }

  if (!posts.length) return console.log('No new posts tagged socials found.');

  posts.sort((a, b) => new Date(b.dateIso) - new Date(a.dateIso));
  const newest = posts[0];
  console.log('Newest post for socials:', newest.path, newest.dateIso);

  if (lastPostedIso && new Date(newest.dateIso) <= new Date(lastPostedIso)) {
    return console.log('No new posts to publish (already posted). Exiting.');
  }

  const fm = matter(newest.content);
  const postLink = `https://niall.garden/${path.basename(newest.path, '.md')}`;
  const socialPreview = fm.data.social_preview !== false && !fm.data.social_no_link;

  if (mastodonBase && mastodonToken) {
    await postToMastodon(mastodonBase, mastodonToken, markdownToPlain(fm.content), socialPreview, postLink);
  }

  if (bskyUser && bskyAppPass) {
    await postToBluesky(bskyUser, bskyAppPass, markdownToPlain(fm.content), socialPreview, postLink);
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
