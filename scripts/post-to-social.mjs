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

  // Remove images
  txt = txt.replace(/!\[.*?\]\(.*?\)/g, '');

  // Trim excess blank lines
  txt = txt.replace(/\n{3,}/g, '\n\n');

  return txt.trim();
}

// Mastodon post (paragraph-safe, 1500-char limit, canonical link on first & last)
async function postToMastodon(baseUrl, token, text, socialPreview = true, link = '') {
  const chunks = [];
  const LIMIT = 1500; // updated limit

  // helper: split a very long paragraph into word-boundary chunks
  function splitLongParagraph(para, limit) {
    const parts = [];
    let remaining = para.trim();
    while (remaining.length > 0) {
      let chunk = remaining.slice(0, limit);
      if (remaining.length > limit) {
        const lastSpace = chunk.lastIndexOf(' ');
        if (lastSpace > 0) chunk = chunk.slice(0, lastSpace);
      }
      parts.push(chunk.trim());
      remaining = remaining.slice(chunk.length).trim();
    }
    return parts;
  }

  if (socialPreview && text.length + link.length + 1 > LIMIT) {
    // Split text into paragraphs first (double line breaks)
    const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    let currentChunk = '';

    for (const para of paragraphs) {
      // If paragraph itself exceeds limit, break the paragraph into smaller parts
      if (para.length > LIMIT) {
        const parts = splitLongParagraph(para, LIMIT);
        for (const part of parts) {
          if (currentChunk && (currentChunk + '\n\n' + part).trim().length <= LIMIT) {
            currentChunk += (currentChunk ? '\n\n' : '') + part;
          } else {
            if (currentChunk) {
              chunks.push(currentChunk.trim());
            }
            currentChunk = part;
          }
        }
        continue;
      }

      // Normal paragraph handling: add paragraph to current chunk if it fits,
      // otherwise push current chunk and start a new one with this paragraph.
      if ((currentChunk + '\n\n' + para).trim().length > LIMIT) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
        }
        currentChunk = para;
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + para;
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }

    // add canonical link to first and last chunk only (M-both)
    if (chunks.length === 1) {
      chunks[0] = `${chunks[0]}\n${link}`;
    } else if (chunks.length > 1) {
      chunks[0] = `${chunks[0]}\n${link}`;
      chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n${link}`;
    }
  } else {
    // Full text + link (single post)
    chunks.push(`${text}\n${link}`);
  }

  // Post chunks as nested replies (each reply to the previous)
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

  const plainText = text;

  const MAX_LEN = 300;
  let finalText;

  if (plainText.length > MAX_LEN && socialPreview) {
    // truncate + read more at canonical link
    const truncated = plainText.slice(0, MAX_LEN - 12).trim();
    finalText = `${truncated}… read more at:\n${postLink}`;
  } else {
    // full text + canonical link
    finalText = `${plainText}\n${postLink}`;
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
  const socialPreview = fm.data.social_preview !== false && !fm.data.social_no_link;

  // Mastodon
  if (mastodonBase && mastodonToken) {
    await postToMastodon(mastodonBase, mastodonToken, markdownToPlain(fm.content), socialPreview, postLink);
  }

  // Bluesky
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
