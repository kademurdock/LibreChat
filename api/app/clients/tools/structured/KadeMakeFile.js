const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { logKadeAsset } = require('~/models/kadeAsset');

/**
 * KadeMakeFile — the tool that hands somebody an actual file.
 *
 * PART 91.4, and the reason it exists is a gap the audit found rather than a
 * feature somebody wanted: this platform could research anything and make
 * pictures, songs and video, and could not produce a spreadsheet. kade_code
 * prints text into a sandbox and throws the sandbox away; My Creations stores
 * media, not documents. That was the whole distance between "Kiana can look it
 * up" and "Kiana can make you the thing."
 *
 * ⚠️ THE RULE THAT MAKES THIS DIFFERENT FROM EVERY OTHER FILE TOOL: a file a
 * blind person cannot open is not a deliverable. Every file made here comes
 * back with a SPOKEN SUMMARY of what is actually inside it — how many rows,
 * what the columns are, what the total says — because "I made you a
 * spreadsheet" is useless to somebody who cannot glance at it. The summary is
 * not decoration; it is the deliverable, and the file is the attachment.
 *
 * It lands in the SAME My Creations lane every image and song already uses, so
 * it appears where the family already knows to look and downloads through the
 * existing /api/kade/asset-download route. No new storage, no new page, no new
 * vendor.
 */

const MAX_ROWS = 5000;
const MAX_COLS = 64;
const MAX_DOC_CHARS = 200000;
const DAILY_CAP = Math.max(1, parseInt(process.env.KADE_FILE_DAILY_CAP, 10) || 20);

const makeFileSchema = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['spreadsheet', 'document', 'csv'],
      description:
        "spreadsheet = a real .xlsx anyone can open in Excel, Numbers or Google Sheets. " +
        "document = a .md text document with real headings, which every screen reader navigates by heading and which Word opens fine. " +
        "csv = the plainest table there is; pick it when the person wants something dead simple or is importing it somewhere.",
    },
    title: {
      type: 'string',
      description:
        "What to call it, in plain words ('August budget', 'Braille display comparison'). Becomes the filename. Say it back to them when you deliver it.",
    },
    rows: {
      type: 'array',
      description:
        "spreadsheet and csv ONLY. An array of rows; each row is an array of cell values. THE FIRST ROW IS THE HEADER — always give it real column names, because the header is what the spoken summary reads out and what a screen reader announces per cell.",
      items: { type: 'array', items: {} },
    },
    text: {
      type: 'string',
      description:
        "document ONLY. Markdown. USE REAL HEADINGS (# and ##) — a screen reader navigates by heading, and a wall of paragraphs is a wall. Write it the way you would say it.",
    },
    sheet_name: {
      type: 'string',
      description: 'spreadsheet only, optional. The tab name. Defaults to the title.',
    },
  },
  required: ['kind', 'title'],
};

/** Filenames land in a download header and a gallery row; keep them boring. */
function safeBase(title) {
  const t = String(title || 'file')
    .replace(/[^\w \-.]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return t || 'file';
}

function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

/** RFC-4180 enough for every spreadsheet program anyone here will open. */
function toCsv(rows) {
  return rows
    .map((r) =>
      r
        .map((v) => {
          const s = String(cell(v));
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\r\n');
}

/**
 * THE SPOKEN SUMMARY. This is the part that matters.
 *
 * A sighted person opens a spreadsheet and takes it in at a glance. Read that
 * same glance out loud: the shape, the columns, and — when a column is all
 * numbers — its total, because the total is what somebody actually wanted
 * nine times out of ten.
 */
function describeTable(rows, kindWord) {
  const header = (rows[0] || []).map((c) => String(cell(c)));
  const body = rows.slice(1);
  const bits = [];
  bits.push(
    `${kindWord} with ${header.length} ${header.length === 1 ? 'column' : 'columns'} and ${body.length} ${
      body.length === 1 ? 'row' : 'rows'
    } of data.`,
  );
  if (header.length) {
    bits.push(`The columns are: ${header.join(', ')}.`);
  }
  // Totals for any fully-numeric column — the glance a sighted reader gets free.
  const totals = [];
  for (let c = 0; c < header.length; c += 1) {
    const vals = body.map((r) => r[c]).filter((v) => v !== '' && v !== null && v !== undefined);
    if (!vals.length) continue;
    const nums = vals.map((v) => (typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''))));
    if (nums.every((n) => Number.isFinite(n))) {
      const sum = nums.reduce((a, b) => a + b, 0);
      totals.push(`${header[c]} totals ${Math.round(sum * 100) / 100}`);
    }
  }
  if (totals.length) bits.push(`${totals.slice(0, 4).join('; ')}.`);
  if (body.length) {
    const first = (body[0] || []).map((v) => String(cell(v))).slice(0, 5).join(', ');
    if (first.trim()) bits.push(`The first row reads: ${first}.`);
  }
  return bits.join(' ');
}

function describeDoc(text) {
  const lines = String(text).split('\n');
  const heads = lines
    .filter((l) => /^#{1,3}\s+\S/.test(l))
    .map((l) => l.replace(/^#{1,3}\s+/, '').trim());
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  const bits = [`A document of about ${words} words.`];
  if (heads.length) {
    bits.push(
      `It has ${heads.length} ${heads.length === 1 ? 'section' : 'sections'}: ${heads.slice(0, 8).join(', ')}.`,
    );
  } else {
    bits.push('It has no headings, so it reads straight through.');
  }
  return bits.join(' ');
}

class KadeMakeFile extends Tool {
  constructor(fields = {}) {
    super();
    this.name = 'kade_make_file';
    this.userId = fields.userId;
    this.req = fields.req;
    this.agentName = fields.agentName;
    // handleTools already hands every tool the app's file strategy — the same
    // field FluxAPI uses. No config lookup of my own.
    this.fileStrategy = fields.fileStrategy;

    this.description =
      'Make a real file the person can open and keep — a spreadsheet, a document, or a CSV — and put it in their My Creations. Free.';
    this.description_for_model =
      "Make a real, downloadable file and save it to the person's My Creations, where every picture and song they've made already lives. " +
      "kind='spreadsheet' for a real .xlsx (Excel, Numbers, Google Sheets all open it); kind='csv' for the plainest possible table; kind='document' for a .md text document. " +
      "USE IT when somebody asks for a spreadsheet, a document, a list they want to keep, a budget, a comparison table, a letter, notes — anything they want OUT of the chat and into a file. It pairs naturally with kade_research: do the research, then make the file from what you found. " +
      "FOR TABLES, the FIRST ROW MUST BE REAL COLUMN HEADERS — the spoken summary reads them out and a screen reader announces them per cell; a table with no header is a table nobody can navigate. FOR DOCUMENTS, USE REAL MARKDOWN HEADINGS (# and ##) because screen readers navigate by heading. " +
      "⚠️ THE ANSWER THIS TOOL GIVES YOU CONTAINS A SPOKEN SUMMARY OF WHAT IS ACTUALLY IN THE FILE — how many rows, which columns, what the numbers total. SAY IT. Kade and several people here are blind, and 'I made you a spreadsheet' with no description is worthless to them: the summary is the deliverable and the file is the attachment. Tell them the filename and that it is in My Creations. " +
      "Never invent data to fill a file. If you only have four real rows, make four rows and say so.";
    this.schema = makeFileSchema;
  }

  async _call(data) {
    const kind = (data && data.kind) || 'document';
    const title = String((data && data.title) || 'Untitled').slice(0, 120);
    if (!this.userId) return 'I cannot save a file without knowing whose it is.';

    try {
      let buffer;
      let ext;
      let spoken;

      if (kind === 'spreadsheet' || kind === 'csv') {
        const rows = Array.isArray(data.rows) ? data.rows : null;
        if (!rows || !rows.length) {
          return 'A spreadsheet needs rows. Give me an array of rows, first row the column headers, and I will build it.';
        }
        if (rows.length > MAX_ROWS) return `That is ${rows.length} rows; the limit is ${MAX_ROWS}.`;
        const clean = rows
          .map((r) => (Array.isArray(r) ? r.slice(0, MAX_COLS).map(cell) : [cell(r)]))
          .slice(0, MAX_ROWS);

        if (kind === 'csv') {
          buffer = Buffer.from(toCsv(clean), 'utf8');
          ext = 'csv';
          spoken = describeTable(clean, 'A CSV table');
        } else {
          // SheetJS is already a dependency of this app — no new vendor.
          const XLSX = require('xlsx');
          const ws = XLSX.utils.aoa_to_sheet(clean);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, String(data.sheet_name || title).slice(0, 31) || 'Sheet1');
          buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
          ext = 'xlsx';
          spoken = describeTable(clean, 'A spreadsheet');
        }
      } else {
        const text = String((data && data.text) || '').trim();
        if (!text) return 'A document needs its text. Write it out and I will save it.';
        if (text.length > MAX_DOC_CHARS) return `That document is ${text.length} characters; the limit is ${MAX_DOC_CHARS}.`;
        const body = text.startsWith('#') ? text : `# ${title}\n\n${text}`;
        buffer = Buffer.from(body, 'utf8');
        ext = 'md';
        spoken = describeDoc(body);
      }

      const { saveBuffer } = getStrategyFunctions(this.fileStrategy);
      if (!saveBuffer) {
        return 'This server has no file storage configured, so I could not save it. Tell them plainly rather than pretending it worked.';
      }

      const stamp = new Date().toISOString().slice(0, 10);
      const fileName = `${safeBase(title)}-${stamp}-${Date.now().toString(36).slice(-4)}.${ext}`;
      const filepath = await saveBuffer({
        userId: String(this.userId),
        buffer,
        fileName,
        basePath: 'uploads',
        tenantId: this.req?.user?.tenantId,
      });

      logKadeAsset({
        userId: this.userId,
        kind: 'document',
        service: 'kade_make_file',
        url: filepath,
        prompt: title,
        model: ext,
        costUSD: 0,
        metadata: { ext, spoken, bytes: buffer.length, madeBy: this.agentName || null },
      });

      logger.info(`[KadeMakeFile] ${ext} "${fileName}" (${buffer.length} bytes) for ${this.userId}`);

      /* The reply is written to be READ ALOUD, in this order on purpose: what
       * it is, what is in it, where it went. The middle part is the one that
       * cannot be skipped. */
      return (
        `Made "${fileName}". ${spoken} ` +
        `It is saved in their My Creations, where they can open or download it. ` +
        `SAY THE DESCRIPTION OUT LOUD to them — they cannot see the file, and the description is the point.`
      );
    } catch (error) {
      logger.error('[KadeMakeFile] failed:', error);
      return `I could not make that file: ${String(error.message || error).slice(0, 200)}. Say so plainly; do not pretend it worked.`;
    }
  }
}

module.exports = KadeMakeFile;
