import assert from 'node:assert/strict';
import test from 'node:test';
import { describedVideoPage } from './page.ts';

/* ------------------------------------------------------------------------------------------
 * A small DOM built from Node built-ins. It parses the page's own HTML, so the tests exercise
 * the markup that is actually served, then runs the page script against it.
 * ---------------------------------------------------------------------------------------- */

const VOID = new Set(['input', 'br', 'meta', 'link', 'img', 'source', 'track', 'hr', 'wbr']);
const RAW = new Set(['script', 'style']);
const decode = (text) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

class Text {
  constructor(text) {
    this.nodeType = 3;
    this.data = text;
    this.parent = null;
  }
  get textContent() {
    return this.data;
  }
}

class Element {
  constructor(doc, tag) {
    this.doc = doc;
    this.nodeType = 1;
    this.localName = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.parent = null;
    this.listeners = {};
    this._value = null;
    this._checked = null;
    this.files = [];
    this.currentTime = 0;
    this.duration = 600;
    this.paused = true;
    this.ended = false;
    this.playbackRate = 1;
    this.selected = false;
  }
  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }
  get parentNode() {
    return this.parent;
  }
  get id() {
    return this.getAttribute('id') || '';
  }
  set id(value) {
    this.setAttribute('id', value);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'selected' && this.localName === 'option') this.selected = true;
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  flag(name, on) {
    if (on) this.setAttribute(name, '');
    else this.removeAttribute(name);
  }
  get hidden() {
    return this.hasAttribute('hidden');
  }
  set hidden(on) {
    this.flag('hidden', !!on);
  }
  get disabled() {
    return this.hasAttribute('disabled');
  }
  set disabled(on) {
    this.flag('disabled', !!on);
  }
  get open() {
    return this.hasAttribute('open');
  }
  set open(on) {
    this.flag('open', !!on);
  }
  get checked() {
    return this._checked === null ? this.hasAttribute('checked') : this._checked;
  }
  set checked(on) {
    this._checked = !!on;
  }
  get type() {
    return this.getAttribute('type') || (this.localName === 'input' ? 'text' : '');
  }
  set type(value) {
    this.setAttribute('type', value);
  }
  get href() {
    return this.getAttribute('href') || '';
  }
  set href(value) {
    this.setAttribute('href', value);
  }
  get label() {
    return this.getAttribute('label') || '';
  }
  set label(value) {
    this.setAttribute('label', value);
  }
  get src() {
    return this.getAttribute('src') || '';
  }
  set src(value) {
    this.setAttribute('src', value);
    if (this.localName === 'video' && this.doc.probeDuration !== undefined && !this.isConnected()) {
      const duration = this.doc.probeDuration;
      queueMicrotask(() => {
        this.duration = duration;
        if (this.onloadedmetadata) this.onloadedmetadata();
      });
    }
  }
  get options() {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.localName === 'option') out.push(child);
        else walk(child);
      }
    };
    walk(this);
    return out;
  }
  get selectedIndex() {
    const options = this.options;
    const index = options.findIndex((option) => option.selected);
    return index >= 0 ? index : options.length ? 0 : -1;
  }
  set selectedIndex(index) {
    this.options.forEach((option, i) => (option.selected = i === index));
  }
  get value() {
    if (this.localName === 'select') {
      const option = this.options[this.selectedIndex];
      return option ? option.value : '';
    }
    if (this.localName === 'option') return this.getAttribute('value') ?? this.textContent;
    if (this.localName === 'textarea') return this._value === null ? this.textContent : this._value;
    return this._value === null ? this.getAttribute('value') || '' : this._value;
  }
  set value(value) {
    if (this.localName === 'select') {
      let found = false;
      for (const option of this.options) {
        option.selected = !found && option.value === String(value);
        if (option.selected) found = true;
      }
      return;
    }
    if (this.localName === 'option') {
      this.setAttribute('value', value);
      return;
    }
    this._value = String(value);
  }
  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }
  set textContent(value) {
    this.childNodes.forEach((node) => (node.parent = null));
    this.childNodes = [];
    if (String(value)) this.appendChild(new Text(String(value)));
  }
  appendChild(node) {
    if (node.parent) node.parent.childNodes = node.parent.childNodes.filter((child) => child !== node);
    node.parent = this;
    this.childNodes.push(node);
    return node;
  }
  remove() {
    if (!this.parent) return;
    this.parent.childNodes = this.parent.childNodes.filter((child) => child !== this);
    this.parent = null;
  }
  isConnected() {
    let node = this;
    while (node.parent) node = node.parent;
    return node === this.doc.root;
  }
  closest(tag) {
    let node = this;
    while (node && node.nodeType === 1) {
      if (node.localName === tag) return node;
      node = node.parent;
    }
    return null;
  }
  get offsetParent() {
    if (!this.isConnected()) return null;
    let node = this;
    while (node && node.nodeType === 1 && node.localName !== '#root') {
      if (node.hidden) return null;
      const parent = node.parent;
      if (parent && parent.localName === 'details' && !parent.open && node.localName !== 'summary') return null;
      node = parent;
    }
    return this.parent;
  }
  querySelectorAll(tag) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.localName === tag) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }
  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== handler);
  }
  focus() {
    this.doc.activeElement = this;
  }
  play() {
    if (this.doc.refusePlay) return Promise.reject(new Error('NotAllowedError'));
    this.paused = false;
    this.ended = false;
    if (this.onplay) this.onplay();
    return Promise.resolve();
  }
  pause() {
    const was = this.paused;
    this.paused = true;
    if (!was && this.onpause) this.onpause();
  }
  load() {}
}

function parse(html, doc) {
  const root = new Element(doc, '#root');
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      i = html.indexOf('-->', i) + 3;
      continue;
    }
    if (html.startsWith('<!', i)) {
      i = html.indexOf('>', i) + 1;
      continue;
    }
    if (html.startsWith('</', i)) {
      const end = html.indexOf('>', i);
      const name = html.slice(i + 2, end).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].localName === name) {
          stack.length = k;
          break;
        }
      }
      i = end + 1;
      continue;
    }
    if (html[i] === '<' && /[a-zA-Z]/.test(html[i + 1] || '')) {
      let j = i + 1;
      while (/[a-zA-Z0-9-]/.test(html[j])) j++;
      const element = new Element(doc, html.slice(i + 1, j));
      for (;;) {
        while (/\s/.test(html[j])) j++;
        if (html[j] === '>' || html.startsWith('/>', j)) break;
        let k = j;
        while (!/[\s=>]/.test(html[k])) k++;
        const name = html.slice(j, k);
        j = k;
        let value = '';
        if (html[j] === '=') {
          j++;
          const quote = html[j];
          if (quote === '"' || quote === "'") {
            const end = html.indexOf(quote, j + 1);
            value = html.slice(j + 1, end);
            j = end + 1;
          } else {
            let end = j;
            while (!/[\s>]/.test(html[end])) end++;
            value = html.slice(j, end);
            j = end;
          }
        }
        element.setAttribute(name.toLowerCase(), decode(value));
      }
      const selfClosing = html.startsWith('/>', j);
      i = j + (selfClosing ? 2 : 1);
      top().appendChild(element);
      if (RAW.has(element.localName)) {
        const end = html.indexOf(`</${element.localName}>`, i);
        element.raw = html.slice(i, end);
        element.appendChild(new Text(element.raw));
        i = end + element.localName.length + 3;
        continue;
      }
      if (!VOID.has(element.localName) && !selfClosing) stack.push(element);
      continue;
    }
    const next = html.indexOf('<', i + 1);
    const text = html.slice(i, next < 0 ? html.length : next);
    top().appendChild(new Text(decode(text)));
    i = next < 0 ? html.length : next;
  }
  return root;
}

function walk(node, visit) {
  for (const child of node.children) {
    visit(child);
    walk(child, visit);
  }
}

function makeDocument(html) {
  const doc = {
    activeElement: null,
    hidden: false,
    title: '',
    listeners: {},
    refusePlay: false,
    probeDuration: undefined,
    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    },
    createElement(tag) {
      return new Element(doc, tag);
    },
    getElementById(id) {
      let found = null;
      walk(doc.root, (node) => {
        if (!found && node.getAttribute('id') === id) found = node;
      });
      return found;
    },
  };
  doc.root = parse(html, doc);
  walk(doc.root, (node) => {
    if (node.localName === 'body') doc.body = node;
    if (node.localName === 'title') doc.title = node.textContent;
  });
  doc.activeElement = doc.body;
  return doc;
}

/* ------------------------------------------------------------------------------------------
 * Timers, storage and a fake server implementing the API in CONTRACT.md.
 * ---------------------------------------------------------------------------------------- */

async function flush(rounds = 40) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

function timers() {
  let now = 0;
  let seq = 1;
  const list = new Map();
  return {
    setTimeout(fn, ms) {
      const id = seq++;
      list.set(id, { at: now + (ms || 0), fn });
      return id;
    },
    clearTimeout(id) {
      list.delete(id);
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...list.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        list.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
    map,
  };
}

const config = {
  enabled: true,
  maxBytes: 2 * 1024 ** 3,
  chunkBytes: 8,
  maxMinutes: 90,
  maxSourceMinutes: 360,
  limitUSD: 5,
  dailyUSD: 5,
  remainingUSD: 5,
  perMinuteUSD: { essential: 0.043, standard: 0.053, rich: 0.066 },
  extrasPerMinuteUSD: { closeLook: 0.025, firstLook: 0.021 },
  setAside: { factor: 1.1, extraUSD: 0.05 },
  previewSeconds: 180,
  library: true,
  defaultLibraryPath: 'Audio/Described Movies & TV/Described by Kade-AI',
  defaultVoice: 'clear woman · flint',
  voicesAvailable: true,
  voices: ['clear woman · flint', 'warm man · oak', 'bright girl · wren'],
  describe: { 'clear woman · flint': 'a calm, clear narrator', 'warm man · oak': 'a warm storyteller' },
  categories: [
    { name: 'Narrators', voices: ['clear woman · flint', 'warm man · oak'] },
    { name: 'Young', voices: ['bright girl · wren'] },
  ],
};

const cents = (value) => Math.round(value * 100) / 100;
let counter = 0;
const newId = () => (++counter).toString(16).padStart(24, '0');

function jobOf(fields = {}) {
  return {
    id: newId(),
    name: 'Video',
    bytes: 1000,
    state: 'ready',
    source: 'upload',
    seconds: 600,
    stage: '',
    progress: 0,
    costUSD: 0,
    runCostUSD: 0,
    copies: [],
    version: 1,
    cancelRequested: false,
    uploadedBytes: 0,
    createdAt: '2026-09-24T10:00:00Z',
    expiresAt: new Date(Date.now() + 5 * 86400000).toISOString(),
    ...fields,
  };
}

const standardSettings = {
  voice: 'warm man · oak',
  rate: 1.5,
  maxRate: 2.25,
  mode: 'extended',
  detail: 'standard',
  volume: 'balanced',
  notes: '',
  closeLook: false,
  firstLook: false,
};

function doneJob(fields = {}) {
  const settings = { ...standardSettings, ...(fields.settings || {}) };
  return jobOf({
    state: 'done',
    settings,
    copies: [{ version: 1, settings, outputSeconds: 610, count: 9, finishedAt: '2026-09-24T10:30:00Z' }],
    descriptions: 9,
    ...fields,
    settings,
  });
}

const scriptCues = [
  { id: '0:0', section: 0, at: 5, until: 8, outputAt: 5, text: 'A red barn stands in snow.', shortText: 'A red barn.', importance: 2, omit: false, spoken: true, spokenText: 'A red barn stands in snow.' },
  { id: '0:1', section: 0, at: 40, until: 44, outputAt: 52, text: 'Frank waves from the porch.', shortText: 'Frank waves from the porch.', importance: 2, omit: false, spoken: true },
  { id: '1:0', section: 1, at: 100, until: 104, outputAt: 118, text: 'A sign reads Meeks Lumber.', shortText: 'Sign: Meeks.', importance: 1, omit: false, spoken: false },
];

function makeServer() {
  const server = {
    jobs: new Map(),
    requests: [],
    overrides: [],
    remainingUSD: 5,
    add(job) {
      this.jobs.set(job.id, job);
      return job;
    },
    override(match, handler, once = true) {
      this.overrides.push({ match, handler, once });
    },
    last(pattern, method) {
      return [...this.requests].reverse().find((r) => pattern.test(r.path) && (!method || r.method === method));
    },
    all(pattern, method) {
      return this.requests.filter((r) => pattern.test(r.path) && (!method || r.method === method));
    },
  };
  const json = (status, body) => ({ status, body });
  const estimate = (job, body) => {
    const s = body.settings || job.settings || standardSettings;
    const seconds = s.range ? s.range.end - s.range.start : job.seconds;
    let minutes = seconds / 60;
    let dialogue = 0;
    const per = config.perMinuteUSD[s.detail || 'standard'] + (s.closeLook ? 0.025 : 0) + (s.firstLook ? 0.021 : 0);
    let value;
    if (body.action === 'preview') {
      minutes = Math.min(3, minutes);
      dialogue = cents((seconds / 60) * 0.0052);
      value = cents(minutes * per + 0.03 + dialogue);
    } else if (body.action === 'revoice') value = cents(minutes * 0.025 + 0.02);
    else if (body.action === 'redo') value = cents(0.03 * (body.sections ? body.sections.length : 2));
    else if (body.action === 'finish') value = cents(minutes * per * 0.7);
    else if (body.action === 'resume') value = cents(minutes * per * 0.5);
    else value = cents(minutes * per + 0.03);
    const setAside = cents(Math.min(config.limitUSD, value * 1.1 + 0.05));
    const allowed = setAside <= server.remainingUSD;
    return {
      estimateUSD: value,
      setAsideUSD: setAside,
      remainingUSD: server.remainingUSD,
      dailyUSD: 5,
      limitUSD: 5,
      allowed,
      reason: allowed ? undefined : `This needs ${'$' + setAside.toFixed(2)} set aside; only ${'$' + server.remainingUSD.toFixed(2)} of today’s allowance is left.`,
      seconds,
      breakdown: { vision: value / 2, speech: value / 4, dialogue, closeLook: 0, firstLook: 0 },
      ...(body.action === 'resume' && job.raiseTo ? { allowUpToUSD: job.raiseTo } : {}),
    };
  };
  server.handle = (method, path, body) => {
    const hit = server.overrides.find((o) => o.match(method, path, body));
    if (hit) {
      if (hit.once) server.overrides.splice(server.overrides.indexOf(hit), 1);
      return hit.handler(method, path, body);
    }
    const [route, query = ''] = path.split('?');
    const parts = route.split('/').filter(Boolean);
    if (route === '/config') return json(200, { ...config, remainingUSD: server.remainingUSD });
    if (route === '/library-folders') return json(200, { folders: ['Audio/Commercials'] });
    if (route === '/jobs' && method === 'GET') return json(200, { jobs: [...server.jobs.values()], remainingUSD: server.remainingUSD });
    if (route === '/uploads') {
      if (body.resumeId && server.jobs.has(body.resumeId)) return json(200, { job: server.jobs.get(body.resumeId), chunkBytes: 8 });
      const job = server.add(jobOf({ name: body.name, bytes: body.bytes, state: 'uploading', seconds: undefined }));
      return json(200, { job, chunkBytes: 8 });
    }
    if (route === '/imports' || route === '/library-imports') {
      return json(202, server.add(jobOf({ name: 'Imported video', state: 'ready', source: route === '/imports' ? 'youtube' : 'library' })));
    }
    if (route === '/sample') return { status: 200, body: 'RIFF', blob: true };
    if (parts[0] !== 'jobs') return json(404, { error: 'Not found' });
    const job = server.jobs.get(parts[1]);
    if (!job) return json(404, { error: 'That video was not found.' });
    const action = parts[2];
    if (!action && method === 'GET') return json(200, job);
    if (!action && method === 'DELETE') {
      server.jobs.delete(job.id);
      return json(200, { ok: true });
    }
    const update = (fields, status = 202) => {
      Object.assign(job, fields);
      return json(status, job);
    };
    const version = Number(new URLSearchParams(query).get('version')) || job.version;
    switch (action) {
      case 'prepare':
        return update({ state: 'checking', seconds: 600 }, 200);
      case 'estimate':
        return json(200, estimate(job, body));
      case 'start':
        return update({ state: 'queued', settings: { ...body }, preview: !!body.preview });
      case 'finish':
      case 'resume':
      case 'redo':
        return update({ state: 'queued', version: job.version + (action === 'redo' ? 1 : 0) });
      case 'reanalyze':
      case 'revoice':
        return update({ state: 'queued', version: job.version + 1 });
      case 'abandon':
        return update({ state: 'done', version: job.copies.at(-1).version, abandonable: false, resumable: false }, 200);
      case 'rehearse':
        return update({ state: 'queued', settings: { ...body } });
      case 'recheck':
        return update({ state: 'checking', recheckable: false }, 200);
      case 'keep':
        return update({ expiresAt: new Date(Date.parse(job.expiresAt) + 7 * 86400000).toISOString(), keepable: false }, 200);
      case 'cancel':
        return update({ cancelRequested: true }, 200);
      case 'rename':
        return update({ name: body.name }, 200);
      case 'script':
        return json(200, { version: job.version, cues: server.cues || scriptCues });
      case 'files':
        return json(200, {
          video: `https://b2/v${version}.mp4`,
          videoDownload: `https://b2/v${version}.mp4?download`,
          audio: `https://b2/a${version}.m4a`,
          audioDownload: 'x',
          transcript: 't',
          transcriptDownload: 'x',
          descriptions: 'd',
          descriptionsDownload: 'x',
          captions: '',
          script: 's',
          scriptDownload: 'x',
          expiresAt: '2026-09-25T00:00:00Z',
        });
      case 'text':
        if (parts[3] === 'descriptions')
          return { status: 200, text: 'WEBVTT\n\n00:00:05.000 --> 00:00:08.000\nA red barn stands in snow.\n\n00:00:52.000 --> 00:00:55.000\nFrank waves from the porch.\n' };
        if (parts[3] === 'transcript')
          return { status: 200, text: 'Video — described transcript\nOriginal length 10 minutes.\n\n0:05 Description: A red barn stands in snow.\n0:30 Frank: Morning, everybody!\n0:52 Description: Frank waves from the porch.\n\nDescriptions that did not fit, with their times in the original video:\n1:40 A sign reads Meeks Lumber.\n' };
        return { status: 200, text: '' };
      case 'library':
        job.copies = job.copies.map((copy) => (copy.version === body.version ? { ...copy, savedToLibrary: true } : copy));
        return json(200, { ...job, savedToLibrary: true, path: body.path || config.defaultLibraryPath });
      default:
        return json(404, { error: 'Unknown route' });
    }
  };
  return server;
}

function respond(result) {
  const status = result.status;
  const body = result.body === undefined || typeof result.body === 'string' ? result.body : JSON.parse(JSON.stringify(result.body));
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (result.text !== undefined || result.blob) throw new SyntaxError('not json');
      if (body === undefined) throw new SyntaxError('empty');
      return body;
    },
    text: async () => (result.text !== undefined ? result.text : JSON.stringify(body)),
    blob: async () => new Blob([body || '']),
  };
}

function page() {
  return describedVideoPage('');
}

async function boot({ server = makeServer(), search = '', local = {}, confirmReply = true, promptReply = null, refresh = true, xhrRoute, wakeLock } = {}) {
  const html = page();
  const document = makeDocument(html);
  const t = timers();
  const dialogs = [];
  const location = {
    href: 'https://kademurdock.com/described-video' + search,
    origin: 'https://kademurdock.com',
    pathname: '/described-video',
    search,
  };
  const history = {
    replaceState(_state, _title, url) {
      const next = new URL(String(url), location.origin);
      location.href = next.href;
      location.search = next.search;
    },
  };
  const localStorage = storage(local);
  const sessionStorage = storage();
  const fetch = (url, init = {}) => {
    const address = new URL(url, location.origin);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (address.pathname === '/api/auth/refresh') {
      const ok = typeof refresh === 'function' ? refresh() : refresh;
      return Promise.resolve(respond(ok ? { status: 200, body: { token: 'T' } } : { status: 401, body: { error: 'no' } }));
    }
    const path = address.pathname.replace('/api/kade/described-video', '') + address.search;
    const entry = { method, path, body };
    server.requests.push(entry);
    return new Promise((resolve, reject) => {
      const signal = init.signal;
      if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      Promise.resolve(server.handle(method, path, body)).then((result) => {
        if (result && result.network) reject(new TypeError('Failed to fetch'));
        else resolve(respond(result));
      });
    });
  };
  class XHR {
    constructor() {
      this.upload = {};
      this.headers = {};
      this.status = 0;
      this.responseText = '';
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(key, value) {
      this.headers[key] = value;
    }
    send(blob) {
      const path = this.url.replace('/api/kade/described-video', '');
      server.requests.push({ method: 'XHR', path, part: this.headers['X-Part-Number'] });
      const route =
        xhrRoute ||
        ((p) => {
          const id = p.split('/')[2];
          const job = server.jobs.get(id);
          if (!job) return { status: 404, body: { error: 'This upload is no longer active.' } };
          job.uploadedBytes = Math.min(job.bytes, (job.uploadedBytes || 0) + (blob.size || 8));
          return { status: 200, body: job };
        });
      Promise.resolve(route(path, this.headers, blob)).then((result) => {
        if (!result) return;
        if (result.error) {
          this.onerror && this.onerror();
          return;
        }
        this.status = result.status;
        this.responseText = JSON.stringify(result.body);
        this.onload && this.onload();
      });
    }
    abort() {
      this.onabort && this.onabort();
    }
  }
  const confirm = (text) => {
    dialogs.push({ kind: 'confirm', text });
    return typeof confirmReply === 'function' ? confirmReply(text) : confirmReply;
  };
  const prompt = (text, value) => {
    dialogs.push({ kind: 'prompt', text, value });
    return typeof promptReply === 'function' ? promptReply(text, value) : promptReply;
  };
  let blobs = 0;
  class PageURL extends URL {
    static createObjectURL(value) {
      if (!(value instanceof Blob)) throw new TypeError('not a blob');
      return `blob:${++blobs}`;
    }
    static revokeObjectURL() {}
  }
  const handlers = {};
  const navigator = { mediaSession: { metadata: null, playbackState: 'none', setActionHandler: (name, fn) => (handlers[name] = fn) }, ...(wakeLock ? { wakeLock } : {}) };
  const windowListeners = {};
  const window = {
    addEventListener: (type, fn) => (windowListeners[type] ||= []).push(fn),
    MediaMetadata: class {
      constructor(data) {
        Object.assign(this, data);
      }
    },
  };
  const scriptText = [];
  walk(document.root, (node) => {
    if (node.localName === 'script') scriptText.push(node.raw);
  });
  const run = new Function(
    'window', 'document', 'location', 'history', 'localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest',
    'confirm', 'prompt', 'setTimeout', 'clearTimeout', 'URL', 'navigator', 'crypto', 'Blob', 'AbortController',
    scriptText.join('\n'),
  );
  run(window, document, location, history, localStorage, sessionStorage, fetch, XHR, confirm, prompt, t.setTimeout, t.clearTimeout, PageURL, navigator, globalThis.crypto, Blob, AbortController);
  await flush();
  await t.advance(100);
  const $ = (id) => document.getElementById('dv-' + id);
  const fire = async (element, type, extra = {}) => {
    const event = { type, target: element, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    const handler = element['on' + type];
    if (handler) handler.call(element, event);
    for (const listener of element.listeners[type] || []) listener.call(element, event);
    await flush();
    return event;
  };
  const click = (id) => fire($(id), 'click');
  const choose = async (id, value) => {
    $(id).value = value;
    await fire($(id), 'change');
  };
  const tick = async (id, on) => {
    const box = $(id);
    if (box.type === 'radio') walk(document.root, (node) => node.getAttribute('name') === box.getAttribute('name') && (node.checked = false));
    box.checked = on;
    await fire(box, 'change');
  };
  const type = async (id, value, event = 'change') => {
    $(id).value = value;
    await fire($(id), event);
  };
  const open = async (job) => {
    const button = $('history').querySelectorAll('button').find((b) => b.getAttribute('data-job') === job.id);
    assert.ok(button, 'job is listed');
    await fire(button, 'click');
    await t.advance(100);
  };
  const status = () => $('status').textContent;
  const visibility = async (hidden) => {
    document.hidden = hidden;
    for (const listener of document.listeners.visibilitychange || []) listener();
    await flush();
  };
  return { document, $, fire, click, choose, tick, type, open, status, visibility, server, timers: t, dialogs, localStorage, location, handlers, windowListeners, navigator };
}

const visible = (element) => element.offsetParent !== null;

/* ------------------------------------------------------------------------------------------
 * Markup: labels, headings, live regions, focus ring and narrow screens.
 * ---------------------------------------------------------------------------------------- */

test('markup: unique ids, every control labelled, headings in order, one live region', () => {
  const document = makeDocument(page());
  const ids = new Map();
  const labels = new Set();
  const controls = [];
  const headings = [];
  const live = [];
  const alerts = [];
  walk(document.root, (node) => {
    const id = node.getAttribute('id');
    if (id) {
      assert.ok(!ids.has(id), `duplicate id ${id}`);
      ids.set(id, node);
    }
    if (node.localName === 'label' && node.getAttribute('for')) labels.add(node.getAttribute('for'));
    if (['input', 'select', 'textarea'].includes(node.localName)) controls.push(node);
    if (/^h[1-6]$/.test(node.localName)) headings.push(Number(node.localName[1]));
    if (node.getAttribute('role') === 'status' || node.getAttribute('aria-live')) live.push(node.id);
    if (node.getAttribute('role') === 'alert') alerts.push(node.id);
  });
  for (const control of controls) {
    const named = labels.has(control.id) || control.closest('label') || control.getAttribute('aria-label') || control.getAttribute('aria-labelledby');
    assert.ok(named, `control ${control.id} has a label`);
  }
  walk(document.root, (node) => {
    if (node.localName === 'button') assert.ok(node.textContent.trim() || node.getAttribute('aria-label'), `button ${node.id} has a name`);
    for (const attribute of ['aria-describedby', 'aria-labelledby']) {
      const value = node.getAttribute(attribute);
      if (value) for (const ref of value.split(/\s+/)) assert.ok(ids.has(ref), `${node.id} ${attribute} points at ${ref}`);
    }
  });
  headings.reduce((previous, level) => {
    assert.ok(level <= previous + 1, `heading level ${level} follows ${previous}`);
    return level;
  }, 0);
  assert.deepEqual(live, ['dv-status']);
  assert.deepEqual(alerts, ['dv-error']);
  assert.equal(ids.get('dv-job-title').getAttribute('tabindex'), '-1');
  assert.equal(ids.get('dv-history-heading').getAttribute('tabindex'), '-1');
});

test('markup: focus ring, narrow screens, upload types, volume and speed wording', () => {
  const html = page();
  assert.match(html, /:focus-visible\{outline:3px solid #174ab0;outline-offset:3px;box-shadow:0 0 0 3px #fff\}/);
  assert.match(html, /@media\(max-width:560px\)\{\.settings\{grid-template-columns:1fr\}/);
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  for (const [, px] of style.matchAll(/(?:^|[;{])\s*(?:min-)?width:(\d+)px/g)) assert.ok(Number(px) <= 320, `fixed width ${px}px`);
  assert.match(style, /overflow-wrap:break-word/);
  assert.match(style, /white-space:normal/);
  for (const extension of ['.ts', '.mts', '.m2ts', '.vob', '.dv', '.3gp', '.flv', '.mxf', '.mod', '.tod']) assert.ok(html.includes(extension + ','.repeat(extension === '.tod' ? 0 : 1)), extension);
  assert.match(html, /Softer: a little below the dialogue/);
  assert.match(html, /Balanced: just above the dialogue/);
  assert.match(html, /Louder: well above it/);
  assert.match(html, /<option value="1.5" selected>1.5×, roughly 220 words a minute<\/option>/);
  assert.match(html, /<option value="2.25" selected>2.25×, roughly 330 words a minute<\/option>/);
  assert.match(html, /Take a closer look at fast scenes, text and logos \(costs more\)/);
  assert.match(html, /<legend>Extra passes \(cost more\)<\/legend>/);
});

/* ------------------------------------------------------------------------------------------
 * Settings belong to one video; paid passes are never switched on silently.
 * ---------------------------------------------------------------------------------------- */

test('notes and extra passes never carry into a new video; her saved narration defaults do', async () => {
  const server = makeServer();
  const a = server.add(doneJob({ name: 'Uncle Bob birthday tape', settings: { detail: 'rich', notes: 'The man in the red sweater is Uncle Bob', closeLook: true } }));
  const env = await boot({
    server,
    local: { 'kade-description-settings': JSON.stringify({ voice: 'bright girl · wren', rate: 2, maxRate: 2.5, mode: 'standard', detail: 'essential', volume: 'louder', closeLook: true, firstLook: true }) },
  });
  const { $ } = env;
  assert.equal($('close-look').checked, false, 'old saved closeLook is not restored on load');
  assert.equal($('first-look').checked, false);
  await env.open(a);
  assert.equal($('notes').value, 'The man in the red sweater is Uncle Bob');
  assert.equal($('close-look').checked, true);
  $('library').value = 'https://kademurdock.com/library?book=' + 'e'.repeat(24);
  await env.fire($('library'), 'input');
  await env.click('library-use');
  await env.timers.advance(100);
  assert.equal($('job-title').textContent, 'Imported video');
  assert.equal($('notes').value, '');
  assert.equal($('close-look').checked, false);
  assert.equal($('first-look').checked, false);
  assert.equal($('voice').value, 'bright girl · wren');
  assert.equal($('rate').value, '2');
  assert.equal($('detail').value, 'essential');
  assert.match(env.status(), /Imported video: checked and ready\..*New video\. Notes are empty and the extra passes are off\./);
  assert.equal($('results').hidden, true, 'the previous video’s results are cleared');
  await env.click('start');
  const start = server.last(/\/start$/);
  assert.equal(start.body.notes, '');
  assert.equal(start.body.closeLook, false);
  assert.equal(start.body.detail, 'essential');
  const saved = JSON.parse(env.localStorage.getItem('kade-description-settings'));
  assert.equal(saved.notes, undefined, 'notes are never remembered');
  assert.equal(saved.closeLook, undefined, 'paid passes are never remembered');
});

test('presets set the choices and speak the price; film offers the first look without ticking it', async () => {
  const server = makeServer();
  const ready = server.add(jobOf({ name: 'KOLR 10 news open', seconds: 600 }));
  const env = await boot({ server, search: '?id=' + ready.id });
  const { $ } = env;
  await env.timers.advance(700);
  assert.equal($('preset-film').checked, true, 'default choices match the Film preset');
  assert.match($('preset-commercials-price').textContent, /about \$0\.94/);
  await env.tick('preset-commercials', true);
  assert.equal($('detail').value, 'rich');
  assert.equal($('mode').value, 'standard');
  assert.equal($('close-look').checked, true);
  await env.timers.advance(700);
  assert.match(env.status(), /^Commercials and logos: rich detail, closer look on, keeping the original length\. Create described copy: about \$0\.94\.$/);
  await env.tick('preset-film', true);
  await env.timers.advance(700);
  assert.equal($('first-look').checked, false);
  assert.equal($('close-look').checked, false);
  assert.match(env.status(), /first look is offered under Extra passes, and it is off\. Create described copy: about \$0\.56\./);
  await env.choose('volume', 'louder');
  assert.equal($('preset-film').checked, true, 'volume is not part of a preset');
  await env.tick('preset-custom', true);
  assert.equal($('customize').open, true);
});

/* ------------------------------------------------------------------------------------------
 * Estimates come from the server and are read with the buttons that spend money.
 * ---------------------------------------------------------------------------------------- */

test('estimates: prices on the spend buttons, set-aside in their description, debounced spoken update', async () => {
  const server = makeServer();
  const ready = server.add(jobOf({ name: 'Film', seconds: 1800 }));
  const env = await boot({ server, search: '?id=' + ready.id });
  const { $ } = env;
  await env.timers.advance(700);
  assert.equal($('start').textContent, 'Create described copy, about $1.62');
  assert.equal($('preview').textContent, 'Try the first 3 minutes, about $0.35');
  assert.equal($('start').getAttribute('aria-describedby'), 'dv-estimate');
  assert.match($('estimate').textContent, /\$1\.62; \$1\.83 is set aside until it finishes/);
  const before = server.all(/\/estimate$/).length;
  await env.tick('close-look', true);
  await env.choose('detail', 'rich');
  await env.timers.advance(300);
  assert.equal(server.all(/\/estimate$/).length, before, 'no request while she is still choosing');
  await env.timers.advance(400);
  assert.match(env.status(), /^Closer look on\. Create described copy: about \$2\.76\.$/);
  const sent = server.last(/\/estimate$/).body;
  assert.equal(sent.settings.detail, 'rich');
  assert.equal(sent.settings.closeLook, true);
});

test('over the allowance: Create stays focusable, says why, and never starts', async () => {
  const server = makeServer();
  server.remainingUSD = 0.4;
  const ready = server.add(jobOf({ name: 'Long film', seconds: 3600 }));
  const env = await boot({ server, search: '?id=' + ready.id });
  const { $ } = env;
  await env.timers.advance(700);
  assert.equal($('start').disabled, false);
  assert.equal($('start').getAttribute('aria-disabled'), 'true');
  await env.click('start');
  assert.match(env.status(), /set aside; only \$0\.40 of today’s allowance is left/);
  assert.equal(server.all(/\/start$/).length, 0);
  assert.equal(env.dialogs.length, 0);
});

test('start: the confirm names the choices, price and set-aside; focus lands on the job heading', async () => {
  const server = makeServer();
  const ready = server.add(jobOf({ name: 'KYTV sign-off 1989', seconds: 120 }));
  const env = await boot({ server, search: '?id=' + ready.id });
  const { $ } = env;
  await env.timers.advance(700);
  assert.equal($('preview').hidden, true, 'a short video gets no preview button');
  assert.equal($('rehearse').hidden, true, 'no rehearsal unless the server offers it');
  $('start').focus();
  await env.type('notes', 'A 1989 station sign-off');
  await env.click('start');
  const text = env.dialogs.at(-1).text;
  assert.match(text, /^Create a described copy of “KYTV sign-off 1989”: Flint at 1\.5×, Standard detail, pausing the picture when needed, closer look off, first look off, notes: A 1989 station sign-off\. About \$0\.14; \$0\.20 is set aside/);
  assert.equal(server.last(/\/start$/).body.notes, 'A 1989 station sign-off');
  assert.equal(env.document.activeElement, $('job-title'));
  assert.match(env.status(), /^Started\./);
  assert.equal($('start').hidden, true);
});

/* ------------------------------------------------------------------------------------------
 * Preview, part of a video, redo, abandon, resume.
 * ---------------------------------------------------------------------------------------- */

test('preview: try the first 3 minutes, then describe the rest', async () => {
  const server = makeServer();
  const ready = server.add(jobOf({ name: 'Feature film', seconds: 5400 }));
  const env = await boot({ server, search: '?id=' + ready.id });
  const { $ } = env;
  await env.timers.advance(700);
  await env.click('preview');
  assert.match(env.dialogs.at(-1).text, /That includes \$0\.47 to learn the dialogue of the whole video\./);
  const start = server.last(/\/start$/);
  assert.equal(start.body.preview, true);
  Object.assign(ready, {
    state: 'done',
    preview: true,
    finishable: true,
    copies: [{ version: 1, preview: true, settings: start.body, outputSeconds: 185, count: 4 }],
  });
  await env.timers.advance(5000);
  assert.match(env.status(), /^Preview ready\./);
  await env.timers.advance(100);
  assert.equal(visible($('finish')), true);
  assert.equal($('finish').textContent, 'Describe the rest, about $3.34');
  assert.equal(visible($('preview-again')), true);
  assert.equal($('revoice').hidden, true);
  assert.match($('version').options[0].textContent, /^Version 1 preview: Flint 1\.5×, Standard detail, 4 descriptions/);
  await env.click('finish');
  assert.match(env.dialogs.at(-1).text, /The preview’s parts are kept and not paid for again\. About \$3\.34; \$3\.72 is set aside until it finishes, and anything unused comes back\./);
  assert.ok(server.last(/\/finish$/, 'POST'));
  await env.click('change-settings');
  assert.equal(env.document.activeElement, $('settings-heading'));
});

test('part of a video: fields are checked on the page, the range is sent and the price spoken', async () => {
  const server = makeServer();
  const ready = server.add(jobOf({ name: 'T-120 tape', seconds: 4 * 3600 }));
  const env = await boot({ server, search: '?id=' + ready.id });
  const { $ } = env;
  await env.timers.advance(700);
  assert.equal($('part').open, true, 'a source longer than one run opens the part fields');
  assert.match(env.status(), /choose the part to describe/);
  assert.equal($('start').getAttribute('aria-disabled'), 'true');
  await env.type('part-from', '1:12:3x');
  assert.equal($('part-from').getAttribute('aria-invalid'), 'true');
  assert.match($('part-error').textContent, /Type the start as hours:minutes:seconds/);
  await env.type('part-from', '1:12:30');
  await env.type('part-to', '3:00:00');
  assert.match($('part-error').textContent, /One run can describe up to 1 hour 30 minutes; this part is 1 hour 47 minutes 30 seconds\./);
  await env.type('part-to', '1:16:00');
  await env.timers.advance(700);
  assert.equal($('part-from').getAttribute('aria-invalid'), null);
  assert.match(env.status(), /^Part: 3 minutes 30 seconds\. Create described copy: about \$0\.22\.$/);
  assert.equal($('part-summary').textContent, 'Describing 1:12:30 to 1:16:00, 3 minutes 30 seconds.');
  await env.click('start');
  assert.deepEqual(server.last(/\/start$/).body.range, { start: 4350, end: 4560 });
});

test('redo, the editor’s describe-this-part-again, abandon and resume with new voice fields', async () => {
  const server = makeServer();
  const done = server.add(doneJob({ name: 'Home video', retryableSections: [2, 5], failedSections: 2, version: 1 }));
  const env = await boot({ server, search: '?id=' + done.id });
  const { $ } = env;
  await env.timers.advance(700);
  assert.equal($('redo').textContent, 'Try again on the 2 parts that could not be described, about $0.06');
  await env.click('redo');
  assert.deepEqual(server.last(/\/redo$/).body, { expectedVersion: 1 });
  Object.assign(done, { state: 'failed', resumable: true, abandonable: true, done: 3, version: 2 });
  await env.timers.advance(5000);
  assert.equal($('abandon').textContent, 'Go back to version 1');
  assert.equal(visible($('resume-note')), true);
  assert.equal($('notes').disabled, true, 'continuing keeps the notes');
  await env.choose('voice', 'bright girl · wren');
  await env.timers.advance(700);
  await env.click('resume');
  assert.deepEqual(server.last(/\/resume$/).body, { voice: 'bright girl · wren', rate: 1.5, maxRate: 2.25, mode: 'extended', volume: 'balanced' });
  Object.assign(done, { state: 'failed' });
  await env.click('abandon');
  assert.ok(server.last(/\/abandon$/));
  assert.match(env.status(), /^Back to version 1\./);
});

/* ------------------------------------------------------------------------------------------
 * Polling, errors and focus.
 * ---------------------------------------------------------------------------------------- */

test('a late poll answer for the old video never switches the page back', async () => {
  const server = makeServer();
  const working = server.add(jobOf({ name: 'Working film', state: 'running', stage: 'Watching section 2 of 9', progress: 20 }));
  const other = server.add(doneJob({ name: 'KYTV sign-off 1989' }));
  const env = await boot({ server, search: '?id=' + working.id });
  const { $ } = env;
  let release;
  server.override((method, path) => path === '/jobs/' + working.id, () => new Promise((resolve) => (release = resolve)));
  await env.timers.advance(5000);
  assert.ok(release, 'a poll is in flight');
  await env.open(other);
  assert.equal($('job-title').textContent, 'KYTV sign-off 1989');
  release({ status: 200, body: { ...working, stage: 'Watching section 3 of 9' } });
  await env.timers.advance(6000);
  assert.equal($('job-title').textContent, 'KYTV sign-off 1989');
  assert.equal($('results').hidden, false);
  assert.equal(server.all(new RegExp('^/jobs/' + working.id + '$')).length, 1, 'no more polls for the old video');
});

test('a failed poll says it is retrying, and the alert clears once the connection is back', async () => {
  const server = makeServer();
  const working = server.add(jobOf({ name: 'Working film', state: 'running', stage: 'Watching section 2 of 9', progress: 20 }));
  const env = await boot({ server, search: '?id=' + working.id });
  const { $ } = env;
  server.override((method, path) => path === '/jobs/' + working.id, () => ({ network: true }));
  await env.timers.advance(5000);
  assert.equal($('error').hidden, false);
  assert.equal($('error').textContent, 'Lost the connection to Kade-AI. Trying again; your video keeps processing on the server.');
  await env.timers.advance(20000);
  assert.equal($('error').hidden, true);
  assert.equal(env.status(), 'Reconnected.');
});

test('a job’s own error is cleared when another video is opened', async () => {
  const server = makeServer();
  const failed = server.add(jobOf({ name: 'Broken', state: 'failed', error: 'Dialogue timing (Deepgram) is not responding.' }));
  const other = server.add(doneJob({ name: 'Fine' }));
  const env = await boot({ server, search: '?id=' + failed.id });
  assert.equal(env.$('error').textContent, 'Dialogue timing (Deepgram) is not responding.');
  assert.equal(env.status(), 'Broken: Stopped before finishing.');
  await env.open(other);
  assert.equal(env.$('error').hidden, true);
});

test('signed out: the sign-in link appears, one message, and polling stops', async () => {
  const server = makeServer();
  const working = server.add(jobOf({ name: 'Working film', state: 'running', stage: 'Watching section 2 of 9' }));
  let allowed = true;
  const env = await boot({ server, search: '?id=' + working.id, refresh: () => allowed });
  allowed = false;
  server.override((method, path) => path === '/jobs/' + working.id, () => ({ status: 401, body: { error: 'Unauthorized' } }));
  await env.timers.advance(5000);
  assert.equal(env.$('signin').hidden, false);
  assert.equal(env.status(), 'You were signed out. Sign in, then come back to this page.');
  const polls = server.all(new RegExp('^/jobs/' + working.id + '$')).length;
  await env.timers.advance(60000);
  assert.equal(server.all(new RegExp('^/jobs/' + working.id + '$')).length, polls);
});

test('cancel: says it is cancelling, keeps focus, and offers Cancel again when stuck', async () => {
  const server = makeServer();
  const working = server.add(jobOf({ name: 'Working film', state: 'running', stage: 'Watching section 2 of 9' }));
  const env = await boot({ server, search: '?id=' + working.id });
  const { $ } = env;
  $('cancel').focus();
  await env.click('cancel');
  assert.equal(env.status(), 'Cancelling. Finished sections are kept; you can continue later.');
  assert.equal($('cancel').textContent, 'Cancelling…');
  assert.equal($('cancel').getAttribute('aria-disabled'), 'true');
  assert.equal($('cancel').disabled, false);
  assert.equal(env.document.activeElement, $('cancel'));
  assert.equal($('stage').textContent, 'Cancelling after the current step…');
  working.cancelStuck = true;
  await env.timers.advance(5000);
  assert.equal($('cancel').getAttribute('aria-disabled'), null);
  assert.equal($('stage').textContent, 'Still stopping. Press Cancel again if it does not stop.');
  Object.assign(working, { state: 'cancelled', cancelRequested: false, cancelStuck: false });
  await env.timers.advance(5000);
  assert.equal($('cancel').hidden, true);
  assert.equal(env.document.activeElement, $('job-title'));
});

test('queue position, progress by quarters, the page title and the list’s current marker', async () => {
  const server = makeServer();
  const queued = server.add(jobOf({ name: 'Logo', state: 'queued', queuePosition: 2 }));
  const other = server.add(jobOf({ name: 'Other film', state: 'running', progress: 10, stage: 'Watching section 1 of 9' }));
  const env = await boot({ server, search: '?id=' + queued.id });
  const { $ } = env;
  assert.equal($('stage').textContent, 'Waiting: 2 videos ahead of this one.');
  assert.equal(env.status(), 'Logo: Waiting: 2 videos ahead of this one.');
  assert.match(env.document.title, /^Waiting: 2 videos ahead of this one — Logo — /);
  const buttons = $('history').querySelectorAll('button');
  assert.equal(buttons.find((b) => b.getAttribute('data-job') === queued.id).getAttribute('aria-current'), 'true');
  Object.assign(queued, { state: 'running', progress: 10, stage: 'Watching section 1 of 9' });
  await env.timers.advance(5000);
  Object.assign(queued, { progress: 30, stage: 'Watching section 3 of 9', etaSeconds: 1200 });
  await env.timers.advance(5000);
  assert.equal(env.status(), 'Describing: 25 percent done, about 20 minutes left.');
  Object.assign(queued, { progress: 35, stage: 'Watching section 4 of 9' });
  await env.timers.advance(5000);
  assert.equal(env.status(), 'Describing: 25 percent done, about 20 minutes left.', 'no chatter between quarters');
  Object.assign(other, { state: 'done' });
  await env.timers.advance(45000);
  assert.match(env.status(), /“Other film” is ready\./);
  await env.open(other);
  assert.equal($('history').querySelectorAll('button').find((b) => b.getAttribute('data-job') === queued.id).getAttribute('aria-current'), null);
});

test('delete: the confirm counts versions and focus goes to Your videos', async () => {
  const server = makeServer();
  const done = server.add(doneJob({ name: 'Old ad' }));
  const env = await boot({ server, search: '?id=' + done.id });
  const { $ } = env;
  $('delete').focus();
  await env.click('delete');
  assert.match(env.dialogs.at(-1).text, /including 1 finished version\?/);
  assert.equal($('job-section').hidden, true);
  assert.equal(env.document.activeElement, $('history-heading'));
  assert.equal($('estimate').textContent, 'Choose a video to see the estimated cost.');
  const deleting = server.add(jobOf({ name: 'Half deleted', state: 'deleting' }));
  await env.click('refresh');
  await env.open(deleting);
  assert.equal($('delete').textContent, 'Finish deleting');
});

/* ------------------------------------------------------------------------------------------
 * Uploads.
 * ---------------------------------------------------------------------------------------- */

test('upload: the page shows the upload, chunks follow it while she browses, and a 502 is retried', async () => {
  const server = makeServer();
  const old = server.add(doneJob({ name: 'Uncle Bob birthday tape' }));
  let fail = true;
  const env = await boot({
    server,
    search: '?id=' + old.id,
    xhrRoute: (path, _headers, blob) => {
      const id = path.split('/')[2];
      if (fail) {
        fail = false;
        return { status: 502, body: { error: 'Bad gateway' } };
      }
      const job = server.jobs.get(id);
      job.uploadedBytes += blob.size;
      return { status: 200, body: job };
    },
  });
  const { $ } = env;
  assert.equal($('results').hidden, false);
  const file = new File(['0123456789abcdef'], 'new tape.mp4', { lastModified: 1 });
  $('file').files = [file];
  await env.fire($('file'), 'change');
  $('upload').focus();
  await env.click('upload');
  await env.timers.advance(5000);
  assert.equal($('job-title').textContent, 'new tape.mp4');
  assert.equal($('results').hidden, true, 'the old video’s results are gone');
  assert.equal(env.document.activeElement, $('stop-upload'));
  assert.equal(env.status(), 'Connection lost, retrying…');
  const uploadId = server.last(/^\/uploads$/) && [...server.jobs.values()].find((j) => j.name === 'new tape.mp4').id;
  await env.open(old);
  await env.timers.advance(5000);
  const parts = server.requests.filter((r) => r.method === 'XHR');
  assert.ok(parts.length >= 3);
  assert.ok(parts.every((r) => r.path === `/jobs/${uploadId}/chunks`), 'every chunk goes to the upload');
  assert.ok(server.last(new RegExp(`/jobs/${uploadId}/prepare$`)));
  assert.equal($('job-title').textContent, 'Uncle Bob birthday tape', 'she stays on the video she opened');
  assert.match(env.status(), /“new tape\.mp4” is uploaded and being checked\./);
  assert.deepEqual(JSON.parse(env.localStorage.getItem('kade-video-uploads')), {});
});

test('upload: a video longer than can be checked is refused before any upload', async () => {
  const env = await boot();
  const { $ } = env;
  env.document.probeDuration = 7 * 3600;
  $('file').files = [new File(['x'], 'whole tape.mp4')];
  await env.fire($('file'), 'change');
  await env.click('upload');
  await env.timers.advance(100);
  assert.equal($('file').getAttribute('aria-invalid'), 'true');
  assert.equal($('upload-error').textContent, 'This video is 7 hours long; the longest that can be checked is 6 hours.');
  assert.equal(env.server.all(/^\/uploads$/).length, 0);
});

test('upload: a stopped upload carries on from the recovery map in a new tab', async () => {
  const server = makeServer();
  const env = await boot({
    server,
    xhrRoute: () => new Promise(() => {}),
  });
  const { $ } = env;
  const file = new File(['0123456789abcdef'], 'tape.mov', { lastModified: 7 });
  $('file').files = [file];
  await env.fire($('file'), 'change');
  await env.click('upload');
  await env.timers.advance(5000);
  assert.equal(typeof env.windowListeners.beforeunload[0], 'function');
  const event = { preventDefault() { this.prevented = true; } };
  env.windowListeners.beforeunload[0](event);
  assert.equal(event.prevented, true, 'leaving the page mid-upload asks first');
  $('stop-upload').focus();
  await env.click('stop-upload');
  await env.timers.advance(100);
  assert.equal(env.document.activeElement, $('upload'));
  assert.equal($('upload').textContent, 'Resume upload and check video');
  const recovery = env.localStorage.getItem('kade-video-uploads');
  const again = await boot({ server, local: { 'kade-video-uploads': recovery } });
  assert.match(again.status(), /Your upload of “tape\.mov” did not finish\. Choose the same file again/);
  again.$('file').files = [file];
  await again.fire(again.$('file'), 'change');
  await again.click('upload');
  await again.timers.advance(5000);
  const id = Object.values(JSON.parse(recovery))[0].jobId;
  assert.equal(server.last(/^\/uploads$/).body.resumeId, id);
});

/* ------------------------------------------------------------------------------------------
 * Finished copies: versions, player, transcript, library, expiry.
 * ---------------------------------------------------------------------------------------- */

test('versions: labels say how they differ, polls do not rebuild them, and a new version never interrupts playback', async () => {
  const server = makeServer();
  const done = server.add(doneJob({ name: 'Ad', copies: [{ version: 1, settings: { ...standardSettings, voice: 'clear woman · flint', detail: 'rich' }, count: 45, savedToLibrary: true, finishedAt: '2026-09-24T15:00:00Z', outputSeconds: 30 }] }));
  const env = await boot({ server, search: '?id=' + done.id });
  const { $ } = env;
  assert.equal(env.document.activeElement, $('result-title'), 'opening from a notice lands on the result');
  assert.equal(visible($('skip')), true);
  assert.match($('version').options[0].textContent, /^Version 1: Flint 1\.5×, Rich detail, 45 descriptions, saved to Library, /);
  await env.timers.advance(700);
  await env.click('revoice');
  const option = $('version').options[0];
  await env.fire($('video'), 'play');
  await env.click('play');
  assert.equal($('video').paused, false);
  await env.timers.advance(5000);
  assert.equal($('version').options[0], option, 'the version list is not rebuilt on every poll');
  done.copies.push({ version: 2, settings: done.settings, count: 45, outputSeconds: 30 });
  Object.assign(done, { state: 'done', version: 2 });
  await env.timers.advance(5000);
  assert.equal($('video').src, 'https://b2/v1.mp4', 'the copy she is hearing keeps playing');
  assert.equal($('switch-version').textContent, 'Switch to version 2');
  assert.match(env.status(), /^Version 2 is ready\. Press Switch to version 2 to hear it\.$/);
  await env.click('switch-version');
  assert.equal($('video').src, 'https://b2/v2.mp4');
  assert.equal(env.document.activeElement, $('result-title'));
});

test('player: description jumps are quiet while playing, audio-only mode, lock-screen controls and remembered position', async () => {
  const server = makeServer();
  const done = server.add(doneJob({ name: 'Ad' }));
  const env = await boot({ server, search: '?id=' + done.id, local: { ['kade-description-position:' + done.id + ':1']: '40' } });
  const { $ } = env;
  assert.equal($('position-note').textContent, 'Playback starts at 0:40, where you stopped last time.');
  assert.equal(env.navigator.mediaSession.metadata.title, 'Ad');
  for (const action of ['play', 'pause', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack']) assert.equal(typeof env.handlers[action], 'function', action);
  $('video').currentTime = 0;
  await env.click('next-cue');
  assert.equal(env.status(), '0:05. A red barn stands in snow.');
  await env.click('play');
  await env.click('next-cue');
  assert.equal(env.status(), '0:52.', 'only the time while the narrator is speaking');
  await env.click('read-cue');
  assert.equal(env.status(), '0:52. Frank waves from the porch.');
  await env.choose('play-as', 'audio');
  assert.equal($('video').paused, true);
  assert.equal($('audio').hidden, false);
  assert.equal($('video').hidden, true);
  assert.equal($('audio').currentTime, $('video').currentTime);
  env.handlers.previoustrack();
  await env.timers.advance(10);
  assert.equal(env.status(), '0:05. A red barn stands in snow.', 'the audio copy is paused, so the text is read');
  $('audio').currentTime = 83;
  await env.fire($('audio'), 'pause');
  $('audio').pause();
  assert.equal(env.localStorage.getItem('kade-description-position:' + done.id + ':1'), '83');
  assert.equal(env.localStorage.getItem('kade-description-play-as'), '"audio"');
});

test('transcript search moves to the matching line and cues the player there', async () => {
  const server = makeServer();
  const done = server.add(doneJob({ name: 'Ad' }));
  const env = await boot({ server, search: '?id=' + done.id });
  const { $ } = env;
  await env.type('find', 'frank', 'input');
  await env.click('find-next');
  assert.equal(env.document.activeElement.textContent, '0:30 Frank: Morning, everybody!');
  assert.equal($('transcript-box').open, true);
  assert.equal($('video').currentTime, 30);
  await env.click('find-next');
  assert.equal(env.document.activeElement.textContent, '0:52 Description: Frank waves from the porch.');
  await env.type('find', 'meeks', 'input');
  $('video').currentTime = 0;
  await env.click('find-next');
  assert.equal(env.document.activeElement.textContent, '1:40 A sign reads Meeks Lumber.');
  assert.equal($('video').currentTime, 0, 'original-video times do not move the player');
  await env.type('find', 'zebra', 'input');
  await env.click('find-next');
  assert.equal(env.status(), 'No line contains zebra.');
});

test('library save: private sources start unshared, a blank folder sends no path, the button names the version', async () => {
  const server = makeServer();
  const done = server.add(doneJob({ name: 'Holly’s tape', source: 'library', sourcePrivate: true, sourceOwner: 'someone else', sourceGrownUps: true }));
  const env = await boot({ server, search: '?id=' + done.id });
  const { $ } = env;
  assert.equal($('share').checked, false);
  assert.equal($('share-help').textContent, 'The original belongs to someone else, so this copy starts private. The original is for grown-ups only, so this copy will be too.');
  assert.equal($('library-save').textContent, 'Save version 1’s described audio to my Library');
  await env.type('folder', '   ');
  await env.click('library-save');
  assert.deepEqual(server.last(/\/library$/).body, { share: false, version: 1 });
  assert.equal($('library-save').getAttribute('aria-disabled'), 'true');
  assert.match($('version').options[0].textContent, /saved to Library/);
});

test('expiry: under a day left is said plainly when the copy opens', async () => {
  const server = makeServer();
  const done = server.add(doneJob({ name: 'Ad', expiresAt: new Date(Date.now() + 5 * 3600000).toISOString() }));
  const env = await boot({ server, search: '?id=' + done.id });
  assert.match(env.$('expiry').textContent, /^This copy will be deleted in about 5 hours, on /);
  assert.match(env.status(), /Ad: finished\. This copy will be deleted in about 5 hours/);
});

test('old download links refresh themselves before opening', async () => {
  const server = makeServer();
  const done = server.add(doneJob({ name: 'Ad' }));
  const env = await boot({ server, search: '?id=' + done.id });
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 3600000;
  try {
    const before = server.all(/\/files\?/).length;
    const event = await env.fire(env.$('video-download'), 'click');
    await env.timers.advance(10);
    assert.equal(event.defaultPrevented, true);
    assert.equal(server.all(/\/files\?/).length, before + 1);
    assert.equal(env.location.href, 'https://b2/v1.mp4?download');
  } finally {
    Date.now = realNow;
  }
});

/* ------------------------------------------------------------------------------------------
 * The script editor.
 * ---------------------------------------------------------------------------------------- */

test('editor: described-copy times, spoken markers, validation, short-version link and cleaned edits', async () => {
  const server = makeServer();
  const done = server.add(doneJob({ name: 'Ad' }));
  const env = await boot({ server, search: '?id=' + done.id });
  const { $ } = env;
  $('editor').open = true;
  await env.click('edit-load');
  const labels = $('edit-cue').options.map((o) => o.textContent);
  assert.deepEqual(labels, ['0:05. A red barn stands in snow.', '0:52, original 0:40. Frank waves from the porch.', 'Not spoken: 1:58, original 1:40. A sign reads Meeks Lumber.']);
  await env.choose('edit-cue', '0:1');
  await env.type('edit-text', 'Uncle Bob waves from the porch.', 'input');
  assert.equal($('edit-short').value, 'Uncle Bob waves from the porch.', 'no short version of its own, so it follows the full text');
  assert.equal($('edit-cue').options[1].textContent, 'Changed: 0:52, original 0:40. Uncle Bob waves from the porch.');
  assert.match($('edit-status').textContent, /^1 description changed in your draft\./);
  await env.choose('edit-cue', '0:0');
  await env.type('edit-text', 'A red barn stands in deep snow.', 'input');
  assert.match($('edit-status').textContent, /The short version still says: “A red barn\.”/);
  assert.equal($('edit-copy-short').hidden, false);
  await env.type('edit-text', '', 'input');
  assert.equal($('edit-text').getAttribute('aria-invalid'), 'true');
  assert.equal($('edit-error').textContent, 'The description at 0:05 is empty. Type new wording or check Leave this description out.');
  const draft = JSON.parse(env.localStorage.getItem('kade-description-draft:' + done.id + ':1'));
  assert.equal(draft['0:0'].text, 'A red barn stands in deep snow.', 'the draft never stores an empty field');
  await env.tick('edit-omit', true);
  assert.equal($('edit-error').hidden, true);
  await env.click('edit-review');
  assert.equal(env.document.activeElement, $('edit-review-list'));
  assert.equal($('edit-review-list').children.length, 2);
  await env.click('edit-save');
  assert.match(env.dialogs.at(-1).text, /^Make version 2 of “Ad” with 2 corrections\? About \$0\.27\./);
  const sent = server.last(/\/revoice$/).body;
  assert.equal(sent.expectedVersion, 1);
  assert.deepEqual(sent.edits.find((e) => e.id === '0:0'), { id: '0:0', text: 'A red barn stands in snow.', shortText: 'A red barn.', omit: true });
  assert.deepEqual(sent.edits.find((e) => e.id === '0:1'), { id: '0:1', text: 'Uncle Bob waves from the porch.', shortText: 'Uncle Bob waves from the porch.', omit: false });
  assert.equal(env.localStorage.getItem('kade-description-draft:' + done.id + ':1'), null);
  assert.equal(env.document.activeElement, $('job-title'));
});

test('editor: correct this description jumps from the player, next and previous move one at a time, redo one part with a note', async () => {
  const server = makeServer();
  const done = server.add(doneJob({ name: 'Ad' }));
  const env = await boot({ server, search: '?id=' + done.id });
  const { $ } = env;
  $('video').currentTime = 60;
  await env.click('correct-cue');
  assert.equal($('editor').open, true);
  assert.equal($('edit-cue').value, '0:1');
  assert.equal(env.document.activeElement, $('edit-text'));
  assert.equal(env.status(), '0:52. Editing: Frank waves from the porch.');
  await env.click('edit-next');
  assert.equal($('edit-cue').value, '1:0');
  await env.click('edit-next');
  assert.equal(env.status(), 'That was the last description.');
  await env.timers.advance(700);
  assert.equal($('edit-redo').textContent, 'Describe this part again, about $0.03');
  await env.type('edit-note', 'The sign says Meeks Lumber');
  await env.click('edit-redo');
  assert.deepEqual(server.last(/\/redo$/).body, { sections: [1], expectedVersion: 1, note: 'The sign says Meeks Lumber' });
});

test('drafts: announced when the copy opens, offered to a plain re-voice, carried over when the wording matches', async () => {
  const server = makeServer();
  const done = server.add(doneJob({ name: 'Ad' }));
  const draft = { '0:1': { id: '0:1', text: 'Uncle Bob waves.', shortText: 'Uncle Bob waves.', omit: false, was: 'Frank waves from the porch.' } };
  const env = await boot({ server, search: '?id=' + done.id, local: { ['kade-description-draft:' + done.id + ':1']: JSON.stringify(draft) } });
  const { $ } = env;
  assert.match(env.status(), /You have 1 unsent correction saved in this browser\./);
  await env.timers.advance(700);
  let asked = '';
  env.dialogs.length = 0;
  await env.click('revoice');
  asked = env.dialogs[0].text;
  assert.match(asked, /^Include your 1 draft correction in the new version\?/);
  assert.equal(server.last(/\/revoice$/).body.edits.length, 1);
  const again = makeServer();
  const two = again.add(doneJob({ name: 'Ad', version: 2 }));
  two.copies.push({ version: 2, settings: two.settings, count: 9 });
  const env2 = await boot({ server: again, search: '?id=' + two.id, local: { ['kade-description-draft:' + two.id + ':1']: JSON.stringify({ ...draft, '9:9': { id: '9:9', text: 'Gone', shortText: 'Gone', omit: false, was: 'Old' } }) } });
  assert.match(env2.status(), /You drafted 2 corrections for version 1, which has since been replaced\./);
  await env2.click('edit-load');
  assert.match(env2.status(), /1 draft correction was carried over from the earlier version\. 1 older correction no longer matches/);
  assert.equal(env2.$('stale').hidden, false);
  assert.equal(JSON.parse(env2.localStorage.getItem('kade-description-draft:' + two.id + ':2'))['0:1'].text, 'Uncle Bob waves.');
});

test('revoice: a changed note is flagged as used only by fresh descriptions', async () => {
  const server = makeServer();
  const done = server.add(doneJob({ name: 'Ad' }));
  const env = await boot({ server, search: '?id=' + done.id });
  const { $ } = env;
  await env.type('notes', 'The woman is Aunt Carol');
  assert.equal($('revoice-note').textContent, 'Your change to notes is only used by Write fresh descriptions.');
  assert.match($('revoice').getAttribute('aria-describedby'), /dv-revoice-note/);
});

/* ------------------------------------------------------------------------------------------
 * Voices, samples and sources.
 * ---------------------------------------------------------------------------------------- */

test('voices unavailable: finished copies still play and download; new narration says why it is off', async () => {
  const server = makeServer();
  const done = server.add(doneJob({ name: 'Ad' }));
  server.override((method, path) => path === '/config', () => ({ status: 200, body: { ...config, voicesAvailable: false, voices: [], categories: [] } }));
  const env = await boot({ server, search: '?id=' + done.id });
  const { $ } = env;
  assert.equal($('results').hidden, false);
  assert.equal($('video').src, 'https://b2/v1.mp4');
  assert.equal($('voice').disabled, true);
  assert.equal($('revoice').getAttribute('aria-disabled'), 'true');
  await env.click('revoice');
  assert.match(env.status(), /^Narrator voices are unavailable right now/);
  assert.equal(server.all(/\/revoice$/).length, 0);
});

test('voice picker: descriptions in the option text, kinds of voice, recently used', async () => {
  const env = await boot({ local: { 'kade-description-recent-voices': JSON.stringify(['warm man · oak']) } });
  const { $ } = env;
  assert.equal($('voice').options[0].textContent, 'clear woman · flint — a calm, clear narrator');
  assert.deepEqual($('voice-kind').options.map((o) => o.textContent), ['All voices', 'Recently used', 'Narrators', 'Young']);
  await env.choose('voice-kind', 'kind:Young');
  assert.deepEqual($('voice').options.map((o) => o.value), ['bright girl · wren']);
  assert.equal(env.status(), '1 voice in Young.');
});

test('samples: fastest speed, pronunciation words, and an honest message when the phone refuses to play', async () => {
  const server = makeServer();
  const env = await boot({ server });
  const { $ } = env;
  await env.choose('max-rate', '2.5');
  await env.click('sample-fast');
  assert.deepEqual(server.last(/^\/sample$/).body, { voice: 'clear woman · flint', rate: 2.5 });
  await env.type('say-text', 'Meeks Lumber');
  await env.click('say-play');
  assert.deepEqual(server.last(/^\/sample$/).body, { voice: 'clear woman · flint', rate: 1.5, text: 'Meeks Lumber' });
  env.document.refusePlay = true;
  await env.click('sample-play');
  assert.equal(env.status(), 'The sample is ready. Press Play on the voice sample player just below.');
  assert.equal(env.document.activeElement, $('sample'));
});

test('a pasted link that is not a Library video explains itself next to the field', async () => {
  const env = await boot();
  const { $ } = env;
  await env.type('library', 'https://kademurdock.com/library', 'input');
  assert.equal($('library').getAttribute('aria-invalid'), 'true');
  assert.match($('library-error').textContent, /^That isn’t a Library video link\./);
  assert.equal($('library-use').disabled, true);
});

test('intro prices and limits come from the server’s figures', async () => {
  const env = await boot();
  assert.equal(env.$('prices').textContent, 'Standard detail costs about 5 cents a minute of video; the extra passes add about 5 cents a minute. Checking a video is free.');
  assert.match(env.$('limits').textContent, /^Up to 2 GB and 6 hours\. One run describes up to 1 hour 30 minutes;/);
  assert.equal(env.status(), 'Choose a video to get started.');
});

test('a running version shows this run’s cost against this run’s estimate, and all versions separately', async () => {
  const server = makeServer();
  const running = server.add(doneJob({ name: 'Film', state: 'running', stage: 'Watching section 3 of 20', progress: 15, costUSD: 3.23, runCostUSD: 0.21, estimatedUSD: 0.79, setAsideUSD: 0.92 }));
  const env = await boot({ server, search: '?id=' + running.id });
  const line = 'This run so far: $0.21 of about $0.79 ($0.92 set aside). All versions of this video: $3.23. Work already sent to a service may still be charged if you cancel.';
  assert.equal(env.$('cost').textContent, line);
  assert.equal(env.$('estimate').textContent, line);
  assert.equal(env.$('results').hidden, false, 'the earlier copy stays playable while the new version runs');
});

test('when the file links fail, the buttons still update and polling carries on', async () => {
  const server = makeServer();
  const ready = server.add(jobOf({ name: 'Ready one' }));
  const running = server.add(doneJob({ name: 'Re-voicing', state: 'running', stage: 'Watching section 1 of 9' }));
  const env = await boot({ server, search: '?id=' + ready.id });
  const { $ } = env;
  server.override((method, path) => /\/files\?/.test(path), () => ({ status: 502, body: { error: 'Bad gateway' } }));
  await env.open(running);
  assert.equal($('start').hidden, true);
  assert.equal($('cancel').hidden, false);
  assert.equal($('settings').disabled, true);
  assert.equal(env.document.activeElement, $('job-title'));
  const polls = server.all(new RegExp('^/jobs/' + running.id + '$')).length;
  await env.timers.advance(5000);
  assert.equal(server.all(new RegExp('^/jobs/' + running.id + '$')).length, polls + 1);
});

test('a forced message that repeats is cleared and written again, so it is heard twice', async () => {
  const server = makeServer();
  const done = server.add(doneJob({ name: 'Ad' }));
  const env = await boot({ server, search: '?id=' + done.id });
  const { $ } = env;
  $('video').currentTime = 100;
  await env.click('next-cue');
  assert.equal(env.status(), 'That was the last description.');
  await env.click('next-cue');
  assert.equal(env.status(), '');
  await env.timers.advance(100);
  assert.equal(env.status(), 'That was the last description.');
});

test('upload: a refusal from the server is final and not retried', async () => {
  const server = makeServer();
  const env = await boot({ server, xhrRoute: () => ({ status: 409, body: { error: 'Choose the original file to resume this upload.' } }) });
  const { $ } = env;
  $('file').files = [new File(['0123456789'], 'clip.mp4')];
  await env.fire($('file'), 'change');
  await env.click('upload');
  await env.timers.advance(5000);
  assert.equal(server.requests.filter((r) => r.method === 'XHR').length, 1);
  assert.equal($('upload-error').textContent, 'Choose the original file to resume this upload.');
  assert.equal($('upload-error').hidden, false);
  assert.equal($('upload').disabled, false);
});

test('upload: a recovery entry for an upload that is gone starts a fresh one instead of failing forever', async () => {
  const server = makeServer();
  const file = new File(['0123456789'], 'clip.mp4', { lastModified: 3 });
  const key = 'clip.mp4|10|3';
  server.override((method, path, body) => path === '/uploads' && !!body.resumeId, () => ({ status: 404, body: { error: 'That video was not found.' } }));
  const env = await boot({ server, local: { 'kade-video-uploads': JSON.stringify({ [key]: { requestId: 'old', jobId: 'f'.repeat(24) } }) } });
  env.$('file').files = [file];
  await env.fire(env.$('file'), 'change');
  await env.click('upload');
  await env.timers.advance(5000);
  const uploads = server.all(/^\/uploads$/);
  assert.equal(uploads.length, 2);
  assert.equal(uploads[1].body.resumeId, undefined);
  assert.notEqual(uploads[1].body.requestId, 'old');
  assert.equal(env.$('error').hidden, true);
  assert.ok(server.last(/\/prepare$/));
});

test('starting an upload while a finished video with notes is open clears the notes', async () => {
  const server = makeServer();
  const done = server.add(doneJob({ name: 'Uncle Bob birthday tape', settings: { notes: 'Uncle Bob wears red', closeLook: true } }));
  const env = await boot({ server, search: '?id=' + done.id, xhrRoute: () => new Promise(() => {}) });
  const { $ } = env;
  assert.equal($('notes').value, 'Uncle Bob wears red');
  $('file').files = [new File(['0123456789'], 'other.mp4')];
  await env.fire($('file'), 'change');
  await env.click('upload');
  await env.timers.advance(5000);
  assert.equal($('job-title').textContent, 'other.mp4');
  assert.equal($('notes').value, '');
  assert.equal($('close-look').checked, false);
  assert.equal(visible($('rename')), true);
  env.dialogs.length = 0;
  const renamed = env.server.requests.length;
  await env.click('delete');
  assert.match(env.dialogs[0].text, /^Delete “other\.mp4”/, 'Delete names the video on screen');
  assert.ok(env.server.requests.length > renamed);
});

/* ------------------------------------------------------------------------------------------
 * Round 2: prices on every spending button, the quote as a limit, uploads that survive the
 * lock screen, repeats, rehearsal, keeping a copy longer, and the honest privacy line.
 * ---------------------------------------------------------------------------------------- */

test('continue and try again: the price and what is kept are in the button, its description and the confirm; Cancel sends nothing', async () => {
  const server = makeServer();
  const failed = server.add(doneJob({ name: 'Home video', state: 'failed', copies: [], resumable: true, done: 3, sections: 12, error: 'Scene description (Gemini) is not responding.' }));
  let reply = false;
  const env = await boot({ server, search: '?id=' + failed.id, confirmReply: () => reply });
  const { $ } = env;
  await env.timers.advance(700);
  assert.equal(visible($('resume')), true);
  assert.equal($('resume').textContent, 'Continue where it stopped: 9 of 12 sections left, about $0.27');
  assert.match($('resume').getAttribute('aria-describedby'), /dv-resume-price/);
  assert.equal($('resume-price').textContent, 'About $0.27; $0.35 is set aside until it finishes. 3 of 12 sections finished; they are kept and not paid for again.');
  assert.equal($('estimate').textContent, 'Continue where it stopped: 9 of 12 sections left, about $0.27. Today’s allowance: $5.00 of today’s $5.00 is left.');
  await env.click('resume');
  assert.equal(env.dialogs.at(-1).text, 'Continue “Home video” with Oak at 1.5×? 3 of 12 sections finished; they are kept and not paid for again. About $0.27; $0.35 is set aside until it finishes, and anything unused comes back. Today’s allowance: $5.00 of today’s $5.00 is left.');
  assert.equal(server.all(/\/resume$/).length, 0, 'dismissing the confirm spends nothing');
  failed.done = 0;
  await env.timers.advance(5000);
  await env.click('refresh');
  await env.open(failed);
  await env.timers.advance(700);
  assert.equal($('resume').textContent, 'Try again from the beginning, about $0.27');
  assert.match($('resume-price').textContent, /No section had finished, so it starts again from the beginning\.$/);
  reply = true;
  await env.click('resume');
  assert.match(env.dialogs.at(-1).text, /^Try “Home video” again from the beginning with Oak at 1\.5×\? No section had finished/);
  assert.ok(server.last(/\/resume$/, 'POST'));
  assert.equal(env.status(), 'Starting again from the beginning.');
});

test('abandon says it costs nothing and that the stopped attempt’s spend is not returned', async () => {
  const server = makeServer();
  const job = server.add(doneJob({ name: 'Ad', state: 'failed', resumable: true, abandonable: true, done: 1, sections: 4, version: 2, runCostUSD: 0.12 }));
  const env = await boot({ server, search: '?id=' + job.id });
  const { $ } = env;
  await env.timers.advance(700);
  assert.equal($('abandon-help').textContent, 'Going back costs nothing. The stopped attempt is discarded, and the $0.12 it already cost is not returned.');
  assert.match($('abandon').getAttribute('aria-describedby'), /dv-abandon-help/);
  await env.click('abandon');
  assert.equal(env.dialogs.at(-1).text, 'Go back to version 1 of “Ad”? Version 1 stays as it was, and going back costs nothing. The stopped attempt is discarded, and the $0.12 it already cost is not returned.');
});

test('over the quote: it says so with the numbers and only carries on after a confirm, with allowUpToUSD', async () => {
  const server = makeServer();
  const job = server.add(
    doneJob({
      name: 'KOLR 10 open',
      state: 'failed',
      copies: [],
      resumable: true,
      overQuote: true,
      done: 2,
      sections: 4,
      runCostUSD: 0.45,
      estimatedUSD: 0.05,
      raiseTo: 0.6,
      error: 'This is costing more than quoted: $0.45 spent of about $0.05. Continue up to $0.60?',
    }),
  );
  let reply = false;
  const env = await boot({ server, search: '?id=' + job.id, confirmReply: () => reply });
  const { $ } = env;
  await env.timers.advance(700);
  assert.equal($('stage').textContent, 'Stopped because it is costing more than quoted.');
  assert.equal($('resume').hidden, true, 'plain Continue is not offered past the quote');
  assert.equal(visible($('allow-more')), true);
  assert.equal($('allow-more').textContent, 'Allow up to $0.60 more and continue');
  assert.equal($('over-quote').textContent, 'This is costing more than quoted: $0.45 spent of about $0.05. It stopped so you can decide. Allowing up to $0.60 more lets it carry on. 2 of 4 sections finished; they are kept and not paid for again.');
  assert.equal($('allow-more').getAttribute('aria-describedby'), 'dv-over-quote');
  assert.match($('estimate').textContent, /^This is costing more than quoted: \$0\.45 spent of about \$0\.05\. Carrying on is expected to cost about \$0\.27 more, and it may spend up to \$0\.60\./);
  await env.click('allow-more');
  assert.equal(env.dialogs.at(-1).text, 'Let “KOLR 10 open” carry on? This is costing more than quoted: $0.45 spent of about $0.05. Carrying on is expected to cost about $0.27 more. It may spend up to $0.60 more, and it stops and asks again before going past that. 2 of 4 sections finished; they are kept and not paid for again. Today’s allowance: $5.00 of today’s $5.00 is left.');
  assert.equal(server.all(/\/resume$/).length, 0);
  reply = true;
  await env.click('allow-more');
  assert.deepEqual(server.last(/\/resume$/).body, { voice: 'warm man · oak', rate: 1.5, maxRate: 2.25, mode: 'extended', volume: 'balanced', allowUpToUSD: 0.6 });
  assert.equal(env.status(), 'Carrying on, up to $0.60 more.');
});

test('over the quote without a server figure: the raise is the resume estimate with headroom, never past the per-run limit', async () => {
  const server = makeServer();
  const stopped = { state: 'failed', copies: [], resumable: true, overQuote: true, done: 1, sections: 30, runCostUSD: 2, estimatedUSD: 1.2 };
  const film = server.add(doneJob({ name: 'Film', seconds: 5400, ...stopped }));
  const long = server.add(doneJob({ name: 'Long film', seconds: 3 * 3600, ...stopped }));
  const env = await boot({ server, search: '?id=' + film.id });
  await env.timers.advance(700);
  assert.equal(env.$('allow-more').textContent, 'Allow up to $3.67 more and continue');
  await env.open(long);
  await env.timers.advance(700);
  assert.equal(env.$('allow-more').textContent, 'Allow up to $5.00 more and continue');
});

test('uploads hold the screen awake, say so once, re-acquire it, retry at once on return and carry on by themselves', async () => {
  const server = makeServer();
  const locks = [];
  const wakeLock = {
    request(type) {
      const lock = { type, released: false, releases: 0, release() { this.released = true; this.releases++; return Promise.resolve(); } };
      locks.push(lock);
      return Promise.resolve(lock);
    },
  };
  let mode = 'hang';
  let release = null;
  const parts = [];
  const env = await boot({
    server,
    wakeLock,
    xhrRoute: (path, headers, blob) => {
      const part = Number(headers['X-Part-Number']);
      parts.push(part);
      const job = server.jobs.get(path.split('/')[2]);
      const ok = () => {
        job.uploadedBytes = Math.min(job.bytes, part * 8);
        return { status: 200, body: job };
      };
      if (part < 3 || mode === 'ok') return ok();
      if (mode === 'drop') return { error: true };
      return new Promise((resolve) => (release = resolve));
    },
  });
  const { $ } = env;
  env.document.probeDuration = 60;
  const file = new File(['0123456789abcdefghijklmn'], 'tape.mov', { lastModified: 9 });
  $('file').files = [file];
  await env.fire($('file'), 'change');
  await env.click('upload');
  await env.timers.advance(10);
  assert.equal(locks.length, 1);
  assert.equal(locks[0].type, 'screen');
  assert.equal(env.status(), 'Uploading tape.mov. Keep this page open; the screen will stay on until the upload finishes.');
  assert.deepEqual(parts, [1, 2, 3]);
  locks[0].released = true;
  await env.visibility(true);
  await env.visibility(false);
  assert.equal(locks.length, 2, 'the lock is asked for again when the page is visible');
  mode = 'drop';
  release({ error: true });
  await flush();
  assert.equal(env.status(), 'Connection lost, retrying…');
  assert.equal(parts.length, 3);
  await env.visibility(false);
  assert.equal(parts.length, 4, 'coming back retries at once instead of waiting');
  await env.timers.advance(200000);
  assert.match($('upload-error').textContent, /^The upload connection keeps dropping\. It carries on by itself when you come back/);
  assert.equal(locks[1].releases, 1, 'the lock is released when the upload stops');
  const id = [...server.jobs.values()].find((j) => j.name === 'tape.mov').id;
  mode = 'ok';
  parts.length = 0;
  await env.visibility(false);
  await env.timers.advance(10);
  assert.equal(server.last(/^\/uploads$/).body.resumeId, id);
  assert.deepEqual(parts, [2, 3], 'it carries on from the last saved chunk');
  assert.ok(server.last(new RegExp(`/jobs/${id}/prepare$`)));
  assert.equal(locks.length, 3);
  assert.equal(locks[2].releases, 1);
  assert.equal($('file').value, '');
});

test('without a wake lock the page still asks her to keep it open', async () => {
  const server = makeServer();
  const env = await boot({ server, xhrRoute: () => new Promise(() => {}) });
  env.document.probeDuration = 60;
  env.$('file').files = [new File(['0123456789'], 'clip.mp4')];
  await env.fire(env.$('file'), 'change');
  await env.click('upload');
  await env.timers.advance(10);
  assert.equal(env.status(), 'Uploading clip.mp4. Keep this page open and the screen on until the upload finishes.');
});

test('a Library video she already has opens that video and says so', async () => {
  const server = makeServer();
  const had = server.add(doneJob({ name: 'KYTV sign-off 1989', source: 'library' }));
  server.override((method, path) => path === '/library-imports', () => ({ status: 200, body: { ...had, existing: true } }));
  const env = await boot({ server });
  const { $ } = env;
  await env.type('library', 'https://kademurdock.com/library?book=' + 'a'.repeat(24) + '&track=2', 'input');
  await env.click('library-use');
  await env.timers.advance(100);
  assert.deepEqual(server.last(/^\/library-imports$/).body.track, 2);
  assert.equal($('job-title').textContent, 'KYTV sign-off 1989');
  assert.equal(env.status(), 'You already have this video: “KYTV sign-off 1989”, finished. It is open now; your described copy is below.');
  assert.equal($('results').hidden, false);
  assert.equal(server.jobs.size, 1, 'no second job was made');
});

test('free rehearsal: offered only when the server says so, free and unconfirmed, and its copy is labelled', async () => {
  const server = makeServer();
  server.override((method, path) => path === '/config', () => ({ status: 200, body: { ...config, rehearsal: true } }));
  const ready = server.add(jobOf({ name: '20 second clip', seconds: 20 }));
  const env = await boot({ server, search: '?id=' + ready.id });
  const { $ } = env;
  await env.timers.advance(700);
  assert.equal(visible($('rehearse')), true);
  assert.equal($('rehearse').textContent, 'Free rehearsal (test tone, no paid services)');
  assert.equal(visible($('rehearse-help')), true);
  await env.click('rehearse');
  assert.equal(env.dialogs.length, 0, 'nothing is spent, so nothing to confirm');
  assert.equal(server.last(/\/rehearse$/).method, 'POST');
  assert.equal(server.all(/\/estimate$/).filter((r) => r.body.action === 'rehearse').length, 0);
  assert.match(env.status(), /^Rehearsal started\./);
  Object.assign(ready, { state: 'done', copies: [{ version: 1, rehearsal: true, settings: standardSettings, outputSeconds: 24, count: 2 }] });
  await env.timers.advance(5000);
  assert.match(env.status(), /^Rehearsal finished\./);
  assert.match($('version').options[0].textContent, /^Version 1 rehearsal with a test tone: /);
  assert.match($('summary').textContent, /^Version 1 is a rehearsal with a test tone, made without paid services: 2 descriptions\./);
  assert.equal($('rehearse').hidden, true);
});

test('keep 7 more days, check again, the suggested Library shelf and the privacy line', async () => {
  const server = makeServer();
  const done = server.add(doneJob({ name: 'Ad', keepable: true, source: 'library', libraryPath: 'Audio/Commercials/Springfield/1996' }));
  const env = await boot({ server, search: '?id=' + done.id });
  const { $ } = env;
  assert.equal(visible($('keep')), true);
  assert.match($('expiry').textContent, /You can also press Keep 7 more days\.$/);
  assert.equal($('folder').value, 'Audio/Commercials/Springfield/1996');
  await env.click('library-save');
  assert.equal(server.last(/\/library$/).body.path, 'Audio/Commercials/Springfield/1996');
  await env.click('keep');
  assert.ok(server.last(/\/keep$/, 'POST'));
  assert.match(env.status(), /^Kept until .*\. That is as long as it can be kept here; download it or save it to your Library to keep it longer\.$/);
  assert.equal($('keep').hidden, true);
  assert.doesNotMatch($('expiry').textContent, /Keep 7 more days/);
  const broken = server.add(jobOf({ name: 'Interrupted', state: 'failed', seconds: undefined, recheckable: true }));
  await env.click('refresh');
  await env.open(broken);
  assert.equal($('stage').textContent, 'The check was interrupted before it finished.');
  assert.equal(visible($('recheck')), true);
  assert.equal($('resume').hidden, true);
  await env.click('recheck');
  assert.ok(server.last(/\/recheck$/, 'POST'));
  assert.equal(env.status(), 'Checking the video again. Checking is free.');
  assert.equal($('recheck').hidden, true);
  const limits = $('limits').textContent;
  for (const service of ['Google Gemini, through OpenRouter', 'Deepgram', 'platform voices']) assert.ok(limits.includes(service), service);
});

test('escaped and two-line WebVTT cues are read back as plain words', async () => {
  const server = makeServer();
  const done = server.add(doneJob({ name: 'Ad' }));
  server.override(
    (method, path) => /\/text\/descriptions/.test(path),
    () => ({ status: 200, text: 'WEBVTT\r\n\r\n1\r\n00:00:05.000 --> 00:00:08.000\r\nA sign reads Meeks &amp; Sons &lt;est. 1952&gt;.\r\n\r\n2\r\n00:52.000 --> 00:55.000\r\nFrank waves\r\nfrom the porch.\r\n' }),
  );
  const env = await boot({ server, search: '?id=' + done.id });
  env.$('video').currentTime = 0;
  await env.click('next-cue');
  assert.equal(env.status(), '0:05. A sign reads Meeks & Sons <est. 1952>.');
  await env.click('next-cue');
  assert.equal(env.status(), '0:52. Frank waves from the porch.');
});
