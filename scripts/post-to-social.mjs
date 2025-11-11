// Mastodon post (paragraph-safe)
async function postToMastodon(baseUrl, token, text, socialPreview = true, link = '') {
  const chunks = [];

  if (socialPreview && text.length + link.length + 1 > 1000) {
    // Split text into paragraphs first
    const paragraphs = text.split(/\n{2,}/); // double line breaks separate paragraphs
    let currentChunk = '';

    for (const para of paragraphs) {
      if ((currentChunk + '\n\n' + para).trim().length > 1000) {
        if (currentChunk) {
          // push previous chunk
          chunks.push(currentChunk.trim() + '\n' + link);
        }
        currentChunk = para; // start new chunk with current paragraph
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + para;
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk.trim() + '\n' + link);
    }
  } else {
    // Full text + link
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
