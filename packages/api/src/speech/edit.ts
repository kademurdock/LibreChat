export interface AukEditOptions {
  edit_start?: number;
  edit_end?: number;
  gen_seconds?: number;
}

export interface AukEditPart {
  editStart: number;
  editEnd: number;
  targetSeconds: number;
  preserveBefore: boolean;
  preserveAfter: boolean;
}

function aukStorageObject(value: string, env: NodeJS.ProcessEnv): { bucket: string; key: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    const buckets = [env.AWS_BUCKET_NAME, env.KADE_MEDIA_BUCKET].filter(
      (bucket): bucket is string => typeof bucket === 'string' && /^[a-z0-9][a-z0-9.-]*$/i.test(bucket),
    );
    if (!buckets.length) return null;
    const region = env.AWS_REGION || '';
    const suffix = region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
    const endpoints = env.AWS_ENDPOINT_URL
      ? [new URL(env.AWS_ENDPOINT_URL)]
      : [`https://s3.${suffix}`, ...(region ? [`https://s3.${region}.${suffix}`, `https://s3-${region}.${suffix}`] : [])].map((endpoint) => new URL(endpoint));
    for (const endpoint of endpoints) {
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || url.port !== endpoint.port) continue;
      const prefix = endpoint.pathname.replace(/\/+$/, '') + '/';
      if (!url.pathname.startsWith(prefix)) continue;
      const object = url.pathname.slice(prefix.length);
      const bucket = buckets.find((name) =>
        (url.hostname === endpoint.hostname && object.startsWith(name + '/') && object.length > name.length + 1) ||
        (url.hostname === name.toLowerCase() + '.' + endpoint.hostname && object.length > 0),
      );
      if (!bucket) continue;
      const key = decodeURIComponent(url.hostname === endpoint.hostname ? object.slice(bucket.length + 1) : object);
      if (!key || /[\\\x00-\x1f]/.test(key) || /%(?:25)*(?:2e|2f|5c)/i.test(key) || key.split('/').some((segment) => segment === '.' || segment === '..')) return null;
      return { bucket, key };
    }
    return null;
  } catch {
    return null;
  }
}

/** Ownership is checked separately; this bounds every edit download to configured object storage. */
export function isAukStorageReference(value: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return aukStorageObject(value, env) !== null;
}

/** Legacy reference registries may contain caller-supplied project URLs; they cannot prove ownership. */
export function isAukOwnedReference(user: string, value: string, assets: string[] = [], env: NodeJS.ProcessEnv = process.env): boolean {
  const object = aukStorageObject(value, env);
  if (!object || !/^[a-z0-9_-]+$/i.test(user)) return false;
  const ownPrefix = `audios/${user}/`;
  if (object.key.startsWith(ownPrefix) && object.key.length > ownPrefix.length) return true;
  return assets.some((source) => {
    const owned = aukStorageObject(source, env);
    return owned?.bucket === object.bucket && owned.key === object.key;
  });
}

/** Stored provider/CDN takes are also valid music references, but must never enter the S3 re-signer. */
export function isOwnedAudioReference(user: string, value: string, assets: string[] = [], env: NodeJS.ProcessEnv = process.env): boolean {
  if (isAukOwnedReference(user, value, assets, env)) return true;
  const identity = (source: string): string | null => {
    try {
      const url = new URL(source);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url.href : null;
    } catch { return null; }
  };
  const key = identity(value);
  return key !== null && assets.some((source) => identity(source) === key);
}

/** Keep each paid job to at most three 28-second source-plus-target windows. */
export function planAukEdit(seconds: number, options: AukEditOptions): AukEditPart[] {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('The recording length could not be read. Import it again before editing.');
  }
  const start = options.edit_start ?? 0;
  const end = options.edit_end ?? seconds;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= seconds || end <= start || end > seconds + 0.05) {
    throw new Error('Choose an edit start and end inside the recording, with the end after the start.');
  }
  const stop = Math.min(end, seconds);
  const target = options.gen_seconds ?? stop - start;
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error('Target seconds must be positive and describe the selected section.');
  }
  const count = Math.ceil((stop - start + target) / 84);
  if (count > 120) {
    throw new Error('That edit is too long for one take. Select a shorter section of the recording.');
  }
  return Array.from({ length: count }, (_, i) => ({
    editStart: start + ((stop - start) * i) / count,
    editEnd: start + ((stop - start) * (i + 1)) / count,
    targetSeconds: target / count,
    preserveBefore: i === 0,
    preserveAfter: i === count - 1,
  }));
}
