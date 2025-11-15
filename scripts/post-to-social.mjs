// /scripts/post-to-social.mjs
// Node 18+ (ESM)
// Autoposts Quartz posts tagged 'socials' to Mastodon & Bluesky

import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import fetch from 'node-fetch';
import { BskyAgent } from '@atproto/api';
import GraphemeSplitter from 'grapheme-splitter';

const CONTENT_DIR = 'content';
const LAST_POST_FILE = 'data/last-social-post.json';
const splitter = new GraphemeSplitter();

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
  txt = txt.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
  txt = txt.replace(/!\[.*?\]\(.*?\)/g, '');
  txt = txt.replace(/\n{3,}/g, '\n\n');
  return txt.trim();
}

// Mastodon post (paragraph-safe, 1500 chars)
async function postToMastodon(baseUrl, token, text, socialPreview = true, link = '') {
  const chunks = [];
  const LIMIT = 1500;

  if (socialPreview && text.length + link.length + 1 > LIMIT) {
    const paragraphs = text.split(/\n{2,}/);
    let currentChunk = '';

    for (const para of paragraphs) {
      if ((currentChunk + '\n\n' + para).trim().length > LIMIT) {
        if (currentChunk) chunks.push(currentChunk.trim() + '\n' + link);
        currentChunk = para;
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + para;
      }
    }

    if (currentChunk) chunks.push(currentChunk.trim() + '\n' + link);
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

// Bluesky post (grapheme-safe 300 chars)
async function postToBluesky(username, appPass, text, socialPreview = true, postLink = '') {
  const agent = new BskyAgent({ service: 'https://bsky.social' });
  await agent.login({ identifier: username, password: appPass });

  const MAX = 300;
  const footer = `… read more at:\n${postLink}`;
  const footerGraphemes = splitter.splitGraphemes(footer);
  const textGraphemes = splitter.splitGraphemes(text);

  let finalText;
  if (socialPreview) {
    if (textGraphemes.length + footerGraphemes.length <= MAX) {
      finalText = text + '\n' + footer;
    } else {
      const allowed = MAX - footerGraphemes.length;
      const truncated = textGraphemes.slice(0, allowed).join('').trim();
      finalText = truncated + '\n' + footer;
    }
  } else {
    const combined = splitter.splitGraphemes(text + '\n' + postLink);
    finalText = combined.slice(0, MAX).join('');
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

  posts.sort((a, b) => new Date(b.dateIso) - new Date(a.dateIso));
  const newest = posts[0];
  console.log('Newest post for socials:', newest.path, newest.dateIso);

  if (lastPostedIso && new Date(newest.dateIso) <= new Date(lastPostedIso)) {
    console.log('No new posts to publish (already posted). Exiting.');
    return;
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
