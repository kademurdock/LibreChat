/**
 * SHARE-TO-DESCRIBE (July 11 2026) — the blind-first flagship.
 *
 * Someone shares (or picks) a photo, video, PDF, Word doc, or text file and
 * gets a rich, screen-reader-first description / read-aloud on /describe.
 *
 * Pipeline pieces live here; routes in ~/server/routes/kadeDescribe.js.
 * Vision model: KADE_VISION_MODEL (default google/gemini-3.1-flash-lite) via
 * OpenRouter — the SAME proven path the gallery auto-describer uses (handles
 * images AND video inline as base64; verified live July 2 2026).
 */
const crypto = require('crypto');
const axios = require('axios');
const { logger } = require('@librechat/data-schemas');

const DESCRIBE_MODEL = process.env.KADE_VISION_MODEL || 'google/gemini-3.1-flash-lite';
const MAX_MEDIA_BYTES = 30 * 1024 * 1024;

/* ---------------------------------------------------------------------------
 * Pending-share store: bounded, short-lived, in-memory. Uploads cost nothing
 * until an AUTHENTICATED /run claims them (the vision call is the only cost),
 * so anonymous share_target POSTs are safe to hold briefly.
 * ------------------------------------------------------------------------- */
const PENDING = new Map();
const PENDING_MAX_ITEMS = 25;
const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_RESULT_TTL_MS = 45 * 60 * 1000;

function sweepPending() {
  const now = Date.now();
  for (const [id, item] of PENDING) {
    if (item.exp <= now) {
      PENDING.delete(id);
    }
  }
}
const sweepTimer = setInterval(sweepPending, 60 * 1000);
if (sweepTimer.unref) {
  sweepTimer.unref();
}

function putShareItem({ buf, mime, name, title, text, userId }) {
  sweepPending();
  while (PENDING.size >= PENDING_MAX_ITEMS) {
    // evict oldest
    const oldest = [...PENDING.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) {
      break;
    }
    PENDING.delete(oldest[0]);
  }
  const id = crypto.randomBytes(16).toString('hex');
  PENDING.set(id, {
    id,
    buf: buf || null,
    mime: mime || null,
    name: name || null,
    title: title || null,
    text: text || null,
    userId: userId || null,
    createdAt: Date.now(),
    exp: Date.now() + PENDING_TTL_MS,
    result: null,
    running: null,
  });
  return id;
}

function getShareItem(id) {
  sweepPending();
  return PENDING.get(String(id || '')) || null;
}

/* ---------------------------------------------------------------------------
 * Personal share token (for the iPhone-Shortcut path — iOS Safari still has
 * no Web Share Target). Stateless: uid.HMAC(secret, uid). Verifiable without
 * storage; rotate the ingest secret to revoke.
 * ------------------------------------------------------------------------- */
function tokenSecret() {
  return process.env.KADE_CALL_INGEST_SECRET || process.env.KADE_USAGE_EVENT_SECRET || null;
}

function mintShareToken(userId) {
  const secret = tokenSecret();
  if (!secret) {
    return null;
  }
  const uid = String(userId);
  const sig = crypto.createHmac('sha256', secret).update(`describe:${uid}`).digest('base64url');
  return `${uid}.${sig}`;
}

function verifyShareToken(token) {
  const secret = tokenSecret();
  if (!secret || !token) {
    return null;
  }
  const idx = String(token).lastIndexOf('.');
  if (idx <= 0) {
    return null;
  }
  const uid = String(token).slice(0, idx);
  const sig = String(token).slice(idx + 1);
  const expect = crypto.createHmac('sha256', secret).update(`describe:${uid}`).digest('base64url');
  try {
    if (
      sig.length === expect.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))
    ) {
      return uid;
    }
  } catch {
    return null;
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * OpenRouter helpers
 * ------------------------------------------------------------------------- */
const IN_USD_PER_M = Number(process.env.KADE_DESCRIBE_IN_USD_PER_M || 0.1);
const OUT_USD_PER_M = Number(process.env.KADE_DESCRIBE_OUT_USD_PER_M || 0.4);


/** Reasoning effort for the vision call: KADE_VISION_REASONING=off|minimal|low|medium|high.
 *  Default: 'low' for Pro-class models (which have mandatory reasoning), omitted otherwise. */
function visionReasoning(model) {
  const eff = process.env.KADE_VISION_REASONING;
  if (eff === 'off') {
    return null;
  }
  if (eff) {
    return { effort: eff };
  }
  return /-pro/.test(String(model)) ? { effort: 'low' } : null;
}

async function orChat(content, maxTokens = 900) {
  const key = process.env.OPENROUTER_KEY;
  if (!key) {
    throw new Error('OPENROUTER_KEY not configured');
  }
  const r = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: DESCRIBE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }],
      usage: { include: true },
      ...(visionReasoning(DESCRIBE_MODEL) ? { reasoning: visionReasoning(DESCRIBE_MODEL) } : {}),
    },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 120000 },
  );
  const text = r.data?.choices?.[0]?.message?.content;
  const usage = r.data?.usage || {};
  const estUSD =
    ((Number(usage.prompt_tokens) || 0) * IN_USD_PER_M +
      (Number(usage.completion_tokens) || 0) * OUT_USD_PER_M) /
    1e6;
  // Prefer OpenRouter's real reported cost; fall back to the env-tunable estimate.
  const costUSD = typeof usage.cost === 'number' && usage.cost >= 0 ? usage.cost : estUSD;
  return { text: typeof text === 'string' ? text.trim() : null, costUSD };
}

const IMAGE_INSTRUCTION =
  'You are the eyes of a blind person who just shared this with you. Describe it thoroughly and vividly, in flowing prose they can listen to. Cover: the overall scene and setting; every person (apparent age, build, hair, skin tone, clothing, facial expression, what they are doing); animals and objects that matter; colors, lighting, and mood; the spatial layout (what is left, right, foreground, background); and ANY text you can read — read it word for word. If it looks like a screenshot, letter, sign, flyer, receipt, or label, read all of its text verbatim after the visual description. Do not start with "This image shows" — start straight in on the scene. Be concrete, warm, and complete rather than brief.';

const VIDEO_INSTRUCTION =
  'You are the eyes of a blind person who just shared this video with you. Describe it thoroughly in flowing prose they can listen to: the setting, every person and what they look like, and — most importantly — WHAT HAPPENS over the course of the video from start to finish, moment by moment. Include camera movement, on-screen text read verbatim, colors, lighting, mood, and anything you can tell about the audio. Do not start with "This video shows" — start straight in. Be concrete and complete rather than brief.';

async function describeMediaBuffer({ buf, mime, kind }) {
  const b64 = Buffer.from(buf).toString('base64');
  const dataUrl = `data:${mime};base64,${b64}`;
  const part =
    kind === 'video'
      ? { type: 'video_url', video_url: { url: dataUrl } }
      : { type: 'image_url', image_url: { url: dataUrl } };
  const instruction = kind === 'video' ? VIDEO_INSTRUCTION : IMAGE_INSTRUCTION;
  return await orChat([{ type: 'text', text: instruction }, part], 1000);
}

/** Scanned/graphical PDF fallback: hand the whole PDF to the model as a file part. */
async function describePdfInline({ buf, name }) {
  const b64 = Buffer.from(buf).toString('base64');
  return await orChat(
    [
      {
        type: 'text',
        text:
          'A blind person shared this PDF with you. First give a 3-5 sentence plain-language summary of what this document is and what it says. Then, under the heading FULL TEXT, transcribe every word of the document in reading order. If parts are unreadable, say so honestly.',
      },
      { type: 'file', file: { filename: name || 'document.pdf', file_data: `data:application/pdf;base64,${b64}` } },
    ],
    2400,
  );
}

/* ---------------------------------------------------------------------------
 * Documents
 * ------------------------------------------------------------------------- */
async function extractPdfText(buf) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(buf) }).promise;
  let fullText = '';
  const maxPages = Math.min(pdf.numPages, 40);
  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .filter((item) => !('type' in item))
      .map((item) => item.str)
      .join(' ');
    fullText += pageText + '\n';
  }
  if (pdf.numPages > maxPages) {
    fullText += `\n[Document continues — ${pdf.numPages - maxPages} more pages not read]\n`;
  }
  return fullText.trim();
}

async function extractDocxText(buf) {
  const { extractRawText } = await import('mammoth');
  const rawText = await extractRawText({ buffer: Buffer.from(buf) });
  return String(rawText.value || '').trim();
}

async function summarizeDocText(text, name) {
  const clipped = String(text).slice(0, 60000);
  return await orChat(
    [
      {
        type: 'text',
        text:
          `A blind person shared a document${name ? ` called "${name}"` : ''} and will LISTEN to your answer. ` +
          'In 3-6 sentences of plain, warm language: what is this document, who is it from or about, and what are the important points — amounts, names, deadlines, and anything they need to act on. No bullet points, no headings, just speakable prose.\n\nDOCUMENT TEXT:\n' +
          clipped,
      },
    ],
    600,
  );
}

/* ---------------------------------------------------------------------------
 * Date / appointment detection → "save as reminder" offers.
 * ------------------------------------------------------------------------- */
function centralNowString() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'long',
  });
  const parts = fmt.formatToParts(new Date()).reduce((o, p) => ((o[p.type] = p.value), o), {});
  const hh = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${hh}:${parts.minute}`;
}

async function extractDates(text) {
  try {
    const clipped = String(text || '').slice(0, 20000);
    if (clipped.length < 12 || !/\d/.test(clipped)) {
      return { dates: [], costUSD: 0 };
    }
    const { text: raw, costUSD } = await orChat(
      [
        {
          type: 'text',
          text:
            `Today is ${centralNowString()} US Central time. The text below came from a document or image a person shared. ` +
            'Find every FUTURE appointment, due date, event, or deadline that has an explicit date. Respond with ONLY a JSON array, no other words: ' +
            '[{"when":"YYYY-MM-DD HH:mm","label":"short plain description"}] — 24-hour Central time; if no time of day is given use 09:00. ' +
            'Past dates, birthdates-as-history, and vague phrases ("next week") are NOT included. If there is nothing, respond with [].\n\nTEXT:\n' +
            clipped,
        },
      ],
      400,
    );
    const m = /\[[\s\S]*\]/.exec(String(raw || ''));
    if (!m) {
      return { dates: [], costUSD };
    }
    const arr = JSON.parse(m[0]);
    const dates = (Array.isArray(arr) ? arr : [])
      .filter(
        (d) =>
          d &&
          typeof d.when === 'string' &&
          /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(d.when.trim()) &&
          typeof d.label === 'string' &&
          d.label.trim(),
      )
      .slice(0, 6)
      .map((d) => ({ when: d.when.trim(), label: d.label.trim().slice(0, 140) }));
    return { dates, costUSD };
  } catch (err) {
    logger.warn('[kadeDescribe] date extraction failed (non-fatal): ' + err.message);
    return { dates: [], costUSD: 0 };
  }
}

/* ---------------------------------------------------------------------------
 * The full pipeline: one share item in, one speakable result out.
 * ------------------------------------------------------------------------- */
async function runDescribe(item) {
  const mime = String(item.mime || '').toLowerCase();
  const name = item.name || null;
  let kind = 'text';
  let description = null;
  let readText = null;
  let docText = null;
  let cost = 0;

  if (item.buf && mime.startsWith('image/')) {
    kind = 'image';
    const { text, costUSD } = await describeMediaBuffer({ buf: item.buf, mime, kind: 'image' });
    description = text;
    cost += costUSD;
  } else if (item.buf && mime.startsWith('video/')) {
    kind = 'video';
    const { text, costUSD } = await describeMediaBuffer({ buf: item.buf, mime, kind: 'video' });
    description = text;
    cost += costUSD;
  } else if (item.buf && (mime === 'application/pdf' || /\.pdf$/i.test(name || ''))) {
    kind = 'document';
    try {
      docText = await extractPdfText(item.buf);
    } catch (err) {
      logger.warn('[kadeDescribe] pdf text extraction failed: ' + err.message);
      docText = '';
    }
    if (docText && docText.replace(/\s+/g, ' ').length >= 150) {
      const { text, costUSD } = await summarizeDocText(docText, name);
      description = text;
      cost += costUSD;
      readText = docText.slice(0, 16000);
    } else {
      // Scanned/image-only PDF: let the vision model read it whole.
      const { text, costUSD } = await describePdfInline({ buf: item.buf, name });
      cost += costUSD;
      const split = /FULL TEXT[:\s]*/i.exec(text || '');
      if (text && split) {
        description = text.slice(0, split.index).trim();
        readText = text.slice(split.index + split[0].length).trim().slice(0, 16000);
        docText = readText;
      } else {
        description = text;
        docText = text || '';
      }
    }
  } else if (
    item.buf &&
    (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      /\.docx$/i.test(name || ''))
  ) {
    kind = 'document';
    docText = await extractDocxText(item.buf);
    if (docText.length >= 40) {
      const { text, costUSD } = await summarizeDocText(docText, name);
      description = text;
      cost += costUSD;
      readText = docText.slice(0, 16000);
    } else {
      description = 'The document appears to be empty or unreadable.';
    }
  } else if (item.buf && (mime.startsWith('text/') || /\.(txt|md|csv|rtf)$/i.test(name || ''))) {
    kind = 'document';
    docText = Buffer.from(item.buf).toString('utf8').slice(0, 60000).trim();
    if (docText.length >= 40) {
      const { text, costUSD } = await summarizeDocText(docText, name);
      description = text;
      cost += costUSD;
      readText = docText.slice(0, 16000);
    } else {
      description = docText || 'The file appears to be empty.';
      readText = null;
    }
  } else if (!item.buf && (item.text || item.title)) {
    kind = 'document';
    docText = `${item.title || ''}\n${item.text || ''}`.trim().slice(0, 60000);
    if (docText.length >= 120) {
      const { text, costUSD } = await summarizeDocText(docText, name);
      description = text;
      cost += costUSD;
      readText = docText.slice(0, 16000);
    } else {
      description = docText;
    }
  } else {
    throw new Error(
      `Sorry — that file type (${mime || 'unknown'}) is not supported yet. Photos, videos, PDFs, Word documents, and text files all work.`,
    );
  }

  if (!description) {
    throw new Error('The describer came back empty — try sharing it again in a moment.');
  }

  // Date/appointment offers: docs always; images too when the description
  // clearly transcribed text (letters, flyers, screenshots).
  const dateSource = docText || (kind === 'image' ? description : '');
  const { dates, costUSD: dateCost } = await extractDates(dateSource);
  cost += dateCost;

  return {
    kind,
    name,
    description,
    readText: readText || null,
    dates,
    costUSD: Math.round(cost * 100000) / 100000,
    model: DESCRIBE_MODEL,
  };
}

module.exports = {
  putShareItem,
  getShareItem,
  mintShareToken,
  verifyShareToken,
  runDescribe,
  PENDING_RESULT_TTL_MS,
  MAX_MEDIA_BYTES,
};
