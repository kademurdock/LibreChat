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

/** Ownership is checked separately; this bounds every edit download to configured object storage. */
export function isAukStorageReference(value: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
    const buckets = [env.AWS_BUCKET_NAME, env.KADE_MEDIA_BUCKET].filter(
      (bucket): bucket is string => typeof bucket === 'string' && /^[a-z0-9][a-z0-9.-]*$/i.test(bucket),
    );
    if (!buckets.length) return false;
    const region = env.AWS_REGION || '';
    const suffix = region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
    const endpoints = env.AWS_ENDPOINT_URL
      ? [new URL(env.AWS_ENDPOINT_URL)]
      : [`https://s3.${suffix}`, ...(region ? [`https://s3.${region}.${suffix}`, `https://s3-${region}.${suffix}`] : [])].map((endpoint) => new URL(endpoint));
    return endpoints.some((endpoint) => {
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || url.port !== endpoint.port) return false;
      const prefix = endpoint.pathname.replace(/\/+$/, '') + '/';
      if (!url.pathname.startsWith(prefix)) return false;
      const object = url.pathname.slice(prefix.length);
      return buckets.some((bucket) =>
        (url.hostname === endpoint.hostname && object.startsWith(bucket + '/') && object.length > bucket.length + 1) ||
        (url.hostname === bucket.toLowerCase() + '.' + endpoint.hostname && object.length > 0),
      );
    });
  } catch {
    return false;
  }
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
