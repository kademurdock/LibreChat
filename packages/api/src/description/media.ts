import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { writeFile, stat } from 'node:fs/promises';
import type { Placement } from './types';
import { tempoFilters } from './timing';

export const sampleRate = 48000;
export const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';
export const ffprobe = () => process.env.FFPROBE_PATH || 'ffprobe';
export async function command(
  bin: string,
  args: string[],
  signal: AbortSignal,
  input?: Buffer,
  maxBytes = 32 * 1024 ** 2,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, signal, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    let bytes = 0;
    let errorText = '';
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 30 * 60 * 1000);
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(output));
    };
    child.on('error', done);
    child.stdout.on('data', (buffer: Buffer) => {
      bytes += buffer.length;
      if (bytes > maxBytes) {
        child.kill('SIGKILL');
        done(new Error('Media output exceeded its limit.'));
        return;
      }
      output.push(buffer);
    });
    child.stderr.on('data', (buffer: Buffer) => {
      errorText = (errorText + buffer.toString()).slice(-3000);
    });
    child.on('close', (code) =>
      done(
        code === 0
          ? undefined
          : new Error(`Media processing failed (${code}): ${errorText.slice(-800)}`),
      ),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

type Probe = {
  format?: { duration?: string };
  streams?: { codec_type?: string; width?: number; height?: number }[];
};
export async function probe(
  file: string,
  signal: AbortSignal,
): Promise<{ seconds: number; audio: boolean }> {
  const raw = await command(
    ffprobe(),
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-show_entries',
      'format=duration:stream=codec_type,width,height',
      '-of',
      'json',
      file,
    ],
    signal,
    undefined,
    1024 * 1024,
  );
  const data: Probe = JSON.parse(raw.toString());
  const seconds = Number(data.format?.duration);
  if (
    !data.streams?.some((stream) => stream.codec_type === 'video' && (stream.width || 0) > 0) ||
    !Number.isFinite(seconds) ||
    seconds < 0.5
  )
    throw new Error('This file does not contain a playable video.');
  return { seconds, audio: data.streams.some((stream) => stream.codec_type === 'audio') };
}

export async function segment(
  source: string,
  directory: string,
  offset: number,
  seconds: number,
  hasAudio: boolean,
  signal: AbortSignal,
): Promise<{ video: string; audio: string }> {
  const video = join(directory, 'analysis.mp4');
  const audio = join(directory, 'dialogue.flac');
  await command(
    ffmpeg(),
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-protocol_whitelist',
      'file,pipe',
      '-ss',
      String(offset),
      '-i',
      source,
      '-t',
      String(seconds),
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      "scale=w='min(960,iw)':h=-2,fps=3",
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '27',
      '-c:a',
      'aac',
      '-ac',
      '1',
      '-b:a',
      '48k',
      '-movflags',
      '+faststart',
      video,
    ],
    signal,
  );
  if ((await stat(video)).size > 28 * 1024 ** 2)
    throw new Error('A video section is too large to analyze.');
  if (hasAudio)
    await command(
      ffmpeg(),
      [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-protocol_whitelist',
        'file,pipe',
        '-ss',
        String(offset),
        '-i',
        source,
        '-t',
        String(seconds),
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'flac',
        audio,
      ],
      signal,
    );
  return { video, audio };
}

export async function decodeVoice(file: string, signal: AbortSignal): Promise<Buffer> {
  return command(
    ffmpeg(),
    [
      '-nostdin',
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      file,
      '-vn',
      '-af',
      'loudnorm=I=-18:TP=-2:LRA=7',
      '-ar',
      String(sampleRate),
      '-ac',
      '1',
      '-f',
      's16le',
      'pipe:1',
    ],
    signal,
    undefined,
    8 * 1024 ** 2,
  );
}
export async function accelerate(pcm: Buffer, rate: number, signal: AbortSignal): Promise<Buffer> {
  return command(
    ffmpeg(),
    [
      '-nostdin',
      '-v',
      'error',
      '-f',
      's16le',
      '-ar',
      String(sampleRate),
      '-ac',
      '1',
      '-i',
      'pipe:0',
      '-af',
      tempoFilters(rate),
      '-f',
      's16le',
      '-ar',
      String(sampleRate),
      '-ac',
      '1',
      'pipe:1',
    ],
    signal,
    pcm,
    8 * 1024 ** 2,
  );
}
export const pcmSeconds = (pcm: Buffer): number => pcm.length / (sampleRate * 2);

export async function renderSegment(
  source: string,
  directory: string,
  index: number,
  offset: number,
  seconds: number,
  hasAudio: boolean,
  placements: Placement[],
  clips: Buffer[],
  signal: AbortSignal,
): Promise<string> {
  const inserts = placements.filter((cue) => cue.inserted);
  const total = seconds + inserts.reduce((sum, cue) => sum + cue.duration + 0.16, 0);
  const narration = Buffer.alloc(Math.ceil(total * sampleRate) * 2);
  placements.forEach((cue, i) =>
    clips[i].copy(narration, Math.round(cue.outputAt * sampleRate) * 2),
  );
  const pcmFile = join(directory, 'narration.pcm');
  await writeFile(pcmFile, narration);
  const args = [
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-protocol_whitelist',
    'file,pipe',
    '-ss',
    String(offset),
    '-t',
    String(seconds),
    '-i',
    source,
  ];
  if (!hasAudio)
    args.push('-f', 'lavfi', '-t', String(seconds), '-i', 'anullsrc=r=48000:cl=stereo');
  const voiceIndex = hasAudio ? 1 : 2;
  args.push('-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', pcmFile);
  const filters: string[] = [];
  filters.push(
    `[0:v:0]scale=w='min(1280,iw)':h=-2,setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[video]`,
  );
  filters.push(
    `[${hasAudio ? '0:a:0' : '1:a:0'}]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=duration=${seconds}[original]`,
  );
  const slices: { from: number; to: number; pause: number }[] = [];
  let cursor = 0;
  for (const cue of inserts) {
    const last = slices[slices.length - 1];
    if (last && Math.abs(last.to - cue.at) < 0.001) {
      last.pause += cue.duration + 0.16;
      continue;
    }
    slices.push({ from: cursor, to: cue.at, pause: cue.duration + 0.16 });
    cursor = cue.at;
  }
  if (cursor < seconds) slices.push({ from: cursor, to: seconds, pause: 0 });
  const count = slices.length;
  filters.push(`[video]split=${count}${slices.map((_, i) => `[v${i}]`).join('')}`);
  filters.push(`[original]asplit=${count}${slices.map((_, i) => `[a${i}]`).join('')}`);
  slices.forEach((slice, i) => {
    filters.push(
      `[v${i}]trim=start=${slice.from}:end=${slice.to},setpts=PTS-STARTPTS${slice.pause ? `,tpad=stop_mode=clone:stop_duration=${slice.pause}` : ''}[sv${i}]`,
    );
    filters.push(
      `[a${i}]atrim=start=${slice.from}:end=${slice.to},asetpts=PTS-STARTPTS${slice.pause ? `,apad=pad_dur=${slice.pause}` : ''}[sa${i}]`,
    );
  });
  filters.push(
    `${slices.map((_, i) => `[sv${i}][sa${i}]`).join('')}concat=n=${count}:v=1:a=1[outv][base]`,
  );
  const active =
    placements
      .map(
        (cue) =>
          `between(t,${Math.max(0, cue.outputAt - 0.03).toFixed(4)},${(cue.outputAt + cue.duration + 0.03).toFixed(4)})`,
      )
      .join('+') || '0';
  filters.push(`[base]volume='if(gt(${active},0),0.45,1)':eval=frame[ducked]`);
  filters.push(`[${voiceIndex}:a]aformat=channel_layouts=stereo[voice]`);
  filters.push(
    '[ducked][voice]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=0:latency=1[outa]',
  );
  const graph = join(directory, 'mix.txt');
  await writeFile(graph, filters.join(';\n'));
  const output = join(directory, `part-${index}.mp4`);
  args.push(
    '-filter_complex_script',
    graph,
    '-map',
    '[outv]',
    '-map',
    '[outa]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '21',
    '-threads',
    '2',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-t',
    String(total),
    '-movflags',
    '+faststart',
    output,
  );
  await command(ffmpeg(), args, signal);
  return output;
}

export async function joinSegments(
  files: string[],
  directory: string,
  signal: AbortSignal,
): Promise<{ video: string; audio: string }> {
  const list = join(directory, 'parts.txt');
  await writeFile(
    list,
    files.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
  );
  const video = join(directory, 'described.mp4');
  const audio = join(directory, 'described.m4a');
  await command(
    ffmpeg(),
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      video,
    ],
    signal,
  );
  await command(
    ffmpeg(),
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-i',
      video,
      '-vn',
      '-c:a',
      'copy',
      '-movflags',
      '+faststart',
      audio,
    ],
    signal,
  );
  return { video, audio };
}
