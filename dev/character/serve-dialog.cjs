const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), vm = require('node:vm');
const { WebSocketServer, WebSocket } = require('ws');
const root = path.join(__dirname, 'out-dialog');
const bridge = process.env.CHARACTER_BRIDGE_SOURCE;
if (!bridge) throw Error('Set CHARACTER_BRIDGE_SOURCE to the held bridge checkout');
const source = fs.readFileSync(path.join(bridge, 'voice-stream.js'), 'utf8');
const start = source.indexOf('async function playBufferWav('), end = source.indexOf('// ── Play', start);
if (start < 0 || end < 0) throw Error('Bridge sender not found');
const sandbox = { characterAudio: require(path.join(bridge, 'character-audio.js')).characterAudio,
  WebSocket, Date, JSON, Math, setTimeout, clearTimeout, wavDurationMs: () => 800, WEB_LEAD_MS: 600 };
vm.createContext(sandbox); vm.runInContext(source.slice(start, end) + '\nglobalThis.play = playBufferWav;', sandbox);
const KIANA = 'agent_6llV0eMu4fmIaj8f2x1Sb';
const file = 'agent-agent_6llV0eMu4fmIaj8f2x1Sb-avatar-1788871984269.png';
const clients = new Set();
const wav = Buffer.alloc(44 + 16000 * .8 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < (wav.length - 44) / 2; i++) wav.writeInt16LE(i / 16000 < .5 ? Math.round(7000 * Math.sin(i * .12)) : 0, 44 + i * 2);
function send(ws, value) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); }
async function action(name) {
  for (const ws of clients) {
    if (name === 'clear') { send(ws, { type: 'clear' }); send(ws, { type: 'state', state: 'listening' }); continue; }
    if (name === 'spotter') { send(ws, { type: 'live-state', on: true }); const pcm = Buffer.concat([Buffer.from('LIVE'), wav.subarray(44)]); ws.send(pcm); continue; }
    if (name === 'off') { send(ws, { type: 'live-state', on: false }); continue; }
    if (name === 'missing') { ws.send(wav); continue; }
    if (name === 'malformed') { send(ws, { type: 'character-audio', version: 9, agentId: KIANA, speech: true }); ws.send(wav); continue; }
    if (name === 'disconnect') { ws.close(); continue; }
    const ids = name === 'queue' ? [KIANA, 'unprepared-speaker', KIANA] : [KIANA];
    for (const agentId of ids) {
      const session = { agentId, llmAbort: true, ws, sendState: state => send(ws, { type: 'state', state }) };
      await sandbox.play(session, name === 'sample' ? fs.readFileSync(path.join(root, 'sample.wav')) : wav,
        { noCaption: name === 'effect' });
    }
    send(ws, { type: 'state', state: 'listening' });
  }
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (url.pathname === '/api/kade/web-voice/ticket') return json({ ticket: 'local-only', wsUrl: 'ws://127.0.0.1:8166/ws' });
  if (url.pathname.startsWith('/api/agents/')) return json({ name: 'Kiana', avatar: { filepath: '/' + file } });
  if (url.pathname === '/api/convos') return json({ conversations: [] });
  if (url.pathname.startsWith('/test/') && req.method === 'POST') { await action(url.pathname.slice(6)); return json({ ok: true }); }
  const dest = path.resolve(root, url.pathname === '/' ? 'index.html' : '.' + url.pathname);
  if (!dest.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
  let actual = url.pathname === '/' + file ? path.join(root, 'assets/characters/kiana/portrait.png') : dest;
  if (!fs.existsSync(actual) || !fs.statSync(actual).isFile()) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', ({ '.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.png':'image/png', '.wav':'audio/wav' })[path.extname(actual)] || 'application/octet-stream');
  fs.createReadStream(actual).pipe(res);
});
const sockets = new WebSocketServer({ server, path: '/ws' });
sockets.on('connection', ws => { clients.add(ws); ws.on('close', () => clients.delete(ws)); ws.on('message', (data, binary) => {
  if (binary) return;
  const m = JSON.parse(data.toString());
  if (m.type === 'hello') send(ws, { type: 'ready' });
  if (m.type === 'barge') { send(ws, { type: 'clear' }); send(ws, { type: 'state', state: 'listening' }); }
  if (m.type === 'bye') ws.close();
}); });
server.listen(8166, '127.0.0.1', () => console.log('Actual call dialog + actual bridge WAV sender: http://127.0.0.1:8166'));
