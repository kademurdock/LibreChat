import React, { memo, useMemo, useRef, useEffect, useState, useContext } from 'react';
import { Download, Loader } from 'lucide-react';
import { useRecoilValue } from 'recoil';
import { useToastContext } from '@librechat/client';
import { PermissionTypes, Permissions, apiBaseUrl } from 'librechat-data-provider';
import Mermaid, { MermaidErrorBoundary } from '~/components/Messages/Content/Mermaid';
import CodeBlock from '~/components/Messages/Content/CodeBlock';
import useHasAccess from '~/hooks/Roles/useHasAccess';
import { useFileDownload } from '~/data-provider';
import { useCodeBlockContext } from '~/Providers';
import { handleDoubleClick, triggerDownload } from '~/utils';
import { useLocalize } from '~/hooks';
import { AuthContext } from '~/hooks/AuthContext';
import store from '~/store';

type TCodeProps = {
  inline?: boolean;
  className?: string;
  children: React.ReactNode;
};

const isSingleLineCode = (children: React.ReactNode): boolean => {
  if (typeof children === 'string') {
    return !children.includes('\n');
  }
  if (Array.isArray(children)) {
    return children.every((child) => typeof child === 'string' && !child.includes('\n'));
  }
  return false;
};

export const code: React.ElementType = memo(function MarkdownCode({
  className,
  children,
}: TCodeProps) {
  const canRunCode = useHasAccess({
    permissionType: PermissionTypes.RUN_CODE,
    permission: Permissions.USE,
  });
  const match = /language-(\w+)/.exec(className ?? '');
  const lang = match && match[1];
  const isMath = lang === 'math';
  const isMermaid = lang === 'mermaid';
  const isSingleLine = isSingleLineCode(children);

  const { getNextIndex, resetCounter } = useCodeBlockContext();
  const blockIndex = useRef(getNextIndex(isMath || isMermaid || isSingleLine)).current;

  useEffect(() => {
    resetCounter();
  }, [children, resetCounter]);

  if (isMath) {
    return <>{children}</>;
  } else if (isMermaid) {
    const content = typeof children === 'string' ? children : String(children);
    return (
      <MermaidErrorBoundary code={content}>
        <Mermaid id={`mermaid-${blockIndex}`}>{content}</Mermaid>
      </MermaidErrorBoundary>
    );
  } else if (isSingleLine) {
    return (
      <code onDoubleClick={handleDoubleClick} className={className}>
        {children}
      </code>
    );
  } else {
    return (
      <CodeBlock
        lang={lang ?? 'text'}
        codeChildren={children}
        blockIndex={blockIndex}
        allowExecution={canRunCode}
      />
    );
  }
});
code.displayName = 'MarkdownCode';

export const codeNoExecution: React.ElementType = memo(function MarkdownCodeNoExecution({
  className,
  children,
}: TCodeProps) {
  const match = /language-(\w+)/.exec(className ?? '');
  const lang = match && match[1];

  if (lang === 'math') {
    return children;
  } else if (lang === 'mermaid') {
    const content = typeof children === 'string' ? children : String(children);
    return <Mermaid>{content}</Mermaid>;
  } else if (isSingleLineCode(children)) {
    return (
      <code onDoubleClick={handleDoubleClick} className={className}>
        {children}
      </code>
    );
  } else {
    return <CodeBlock lang={lang ?? 'text'} codeChildren={children} allowExecution={false} />;
  }
});
codeNoExecution.displayName = 'MarkdownCodeNoExecution';

/**
 * Kade fork: iPhone-friendly "Save to device" button for inline generated clips
 * (Seed Audio / Rio video). Safari's native <audio>/<video> players give no
 * reliable way to KEEP a clip, and a plain <a download> to a cross-origin
 * fal.media URL just plays it. So we pull the file through our own same-origin,
 * authenticated proxy (/api/kade/media-save) and hand it to the platform: on
 * iOS the native share sheet (Save to Files / Messages), on desktop a normal
 * download. iOS needs share() on a fresh tap, so there it is a two-tap flow
 * (tap 1 fetches, tap 2 shares). Mirrors the working /my-creations button.
 */
type TInlineMediaSaveProps = {
  src: string;
  kind: 'audio' | 'video';
  description: string;
};

const isIOSDevice = (): boolean => {
  const nav = navigator as Navigator & { maxTouchPoints?: number };
  return (
    /iP(hone|ad|od)/.test(nav.userAgent) ||
    (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1)
  );
};

export const InlineMediaSaveButton: React.ElementType = memo(function InlineMediaSaveButton({
  src,
  kind,
  description,
}: TInlineMediaSaveProps) {
  const auth = useContext(AuthContext);
  const token = auth?.token;
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const cacheRef = useRef<{ blob: Blob; name: string } | null>(null);
  const kindWord = kind === 'video' ? 'video' : 'audio clip';
  const defaultType = kind === 'video' ? 'video/mp4' : 'audio/mpeg';

  const fetchBlob = async (): Promise<{ blob: Blob; name: string }> => {
    const res = await fetch('/api/kade/media-save?u=' + encodeURIComponent(src.trim()), {
      credentials: 'include',
      headers: token != null && token !== '' ? { Authorization: 'Bearer ' + token } : undefined,
    });
    if (!res.ok) {
      throw new Error('HTTP ' + res.status);
    }
    const cd = res.headers.get('Content-Disposition') ?? '';
    const m = cd.match(/filename="?([^"]+)"?/);
    const name = m != null ? m[1] : 'kade-ai-' + kind + (kind === 'video' ? '.mp4' : '.mp3');
    const blob = await res.blob();
    return { blob, name };
  };

  const run = async (): Promise<void> => {
    if (busy) {
      return;
    }
    // iOS: share() must fire on a fresh tap -> fetch first, share on the next tap.
    if (isIOSDevice()) {
      if (cacheRef.current != null) {
        try {
          const { blob, name } = cacheRef.current;
          const file = new File([blob], name, { type: blob.type || defaultType });
          const nav = navigator as Navigator & {
            canShare?: (data?: { files?: File[] }) => boolean;
            share?: (data?: { files?: File[]; title?: string }) => Promise<void>;
          };
          if (nav.canShare?.({ files: [file] }) === true && nav.share) {
            await nav.share({ files: [file], title: name });
            setStatus('Share sheet opened — choose Save to Files (or send it) to keep this ' + kindWord + '.');
          } else {
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            setStatus('Opened in a new tab — use the share button there to save it.');
          }
        } catch (e) {
          if ((e as Error).name !== 'AbortError') {
            setStatus('Could not open the share sheet — tap Save again.');
          }
        }
        return;
      }
      setBusy(true);
      setStatus('Getting your ' + kindWord + ' ready…');
      try {
        cacheRef.current = await fetchBlob();
        setStatus('Ready! Tap “Save to device” again to open the share sheet, then choose Save.');
      } catch {
        setStatus('Could not get the file — try again in a moment.');
      } finally {
        setBusy(false);
      }
      return;
    }
    // Desktop / Android: fetch then download.
    setBusy(true);
    setStatus('Downloading your ' + kindWord + '…');
    try {
      const got = cacheRef.current ?? (await fetchBlob());
      const url = URL.createObjectURL(got.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = got.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setStatus('Saved! Check your downloads for ' + got.name + '.');
    } catch {
      setStatus('Download failed — try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="mt-1 block">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border-medium bg-surface-secondary px-3 py-1.5 text-sm font-semibold text-text-primary hover:bg-surface-hover disabled:opacity-60"
        aria-label={'Save this ' + kindWord + ' to your device: ' + description}
      >
        {busy ? (
          <Loader className="h-[18px] w-[18px] animate-spin" aria-hidden="true" />
        ) : (
          <Download className="h-[18px] w-[18px]" aria-hidden="true" />
        )}
        Save to device
      </button>
      <span role="status" aria-live="polite" className="mt-1 block text-sm text-text-secondary">
        {status}
      </span>
    </span>
  );
});
InlineMediaSaveButton.displayName = 'InlineMediaSaveButton';

/**
 * Kade fork: inline video player for generated clips (fal.media etc.).
 * Detects direct video-file URLs so `[Watch the video](...mp4)` — or a model
 * mistakenly writing `![...](...mp4)` — renders as a real playable <video>
 * instead of a bare link / forever-loading broken image.
 */
const VIDEO_URL_PATTERN = /^https?:\/\/\S+\.(mp4|webm|mov|m4v)(\?\S*)?$/i;

export const isVideoUrl = (url?: string): boolean =>
  typeof url === 'string' && VIDEO_URL_PATTERN.test(url.trim());

type TInlineVideoProps = {
  src: string;
  label?: string;
};

export const InlineVideo: React.ElementType = memo(function InlineVideo({
  src,
  label,
}: TInlineVideoProps) {
  const description = label && label.trim() !== '' ? label.trim() : 'Generated video';
  return (
    <span className="my-2 block max-w-lg">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        controls
        preload="metadata"
        playsInline
        aria-label={description}
        className="w-full rounded-lg border border-border-light"
      >
        <source src={src.trim()} />
        Your browser cannot play this video inline.
      </video>
      <a
        href={src.trim()}
        target="_blank"
        rel="noreferrer"
        className="mt-1 block text-sm text-text-secondary underline"
        aria-label={`Open or download the video in a new tab: ${description}`}
      >
        {description} — open or download
      </a>
      <InlineMediaSaveButton src={src.trim()} kind="video" description={description} />
    </span>
  );
});
InlineVideo.displayName = 'InlineVideo';

/**
 * Kade fork: inline audio player for generated clips (Seed Audio / fal.media).
 * Detects direct audio-file URLs so `[Play the audio](...mp3)` renders as a
 * real playable <audio> element — audio is how blind users experience this
 * platform, so a working inline player matters.
 */
const AUDIO_URL_PATTERN = /^https?:\/\/\S+\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)(\?\S*)?$/i;

export const isAudioUrl = (url?: string): boolean =>
  typeof url === 'string' && AUDIO_URL_PATTERN.test(url.trim());

type TInlineAudioProps = {
  src: string;
  label?: string;
};

export const InlineAudio: React.ElementType = memo(function InlineAudio({
  src,
  label,
}: TInlineAudioProps) {
  const description = label && label.trim() !== '' ? label.trim() : 'Generated audio';
  return (
    <span className="my-2 block max-w-lg">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio controls preload="metadata" aria-label={description} className="w-full">
        <source src={src.trim()} />
        Your browser cannot play this audio inline.
      </audio>
      <a
        href={src.trim()}
        target="_blank"
        rel="noreferrer"
        className="mt-1 block text-sm text-text-secondary underline"
        aria-label={`Open or download the audio in a new tab: ${description}`}
      >
        {description} — open or download
      </a>
      <InlineMediaSaveButton src={src.trim()} kind="audio" description={description} />
    </span>
  );
});
InlineAudio.displayName = 'InlineAudio';

type TAnchorProps = {
  href: string;
  children: React.ReactNode;
};

export const a: React.ElementType = memo(function MarkdownAnchor({ href, children }: TAnchorProps) {
  const user = useRecoilValue(store.user);
  const { showToast } = useToastContext();
  const localize = useLocalize();

  const {
    file_id = '',
    filename = '',
    filepath,
  } = useMemo(() => {
    const pattern = new RegExp(`(?:files|outputs)/${user?.id}/([^\\s]+)`);
    const match = href.match(pattern);
    if (match && match[0]) {
      const path = match[0];
      const parts = path.split('/');
      const name = parts.pop();
      const file_id = parts.pop();
      return { file_id, filename: name, filepath: path };
    }
    return { file_id: '', filename: '', filepath: '' };
  }, [user?.id, href]);

  const { refetch: downloadFile } = useFileDownload(user?.id ?? '', file_id, { direct: false });
  const props: { target?: string; onClick?: React.MouseEventHandler } = { target: '_blank' };

  if (isVideoUrl(href)) {
    const label = typeof children === 'string' ? children : undefined;
    return <InlineVideo src={href} label={label} />;
  }

  if (isAudioUrl(href)) {
    const label = typeof children === 'string' ? children : undefined;
    return <InlineAudio src={href} label={label} />;
  }

  if (!file_id || !filename) {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  }

  const handleDownload = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    try {
      const stream = await downloadFile();
      if (stream.data == null || stream.data === '') {
        console.error('Error downloading file: No data found');
        showToast({
          status: 'error',
          message: localize('com_ui_download_error'),
        });
        return;
      }
      triggerDownload(stream.data, filename);
    } catch (error) {
      console.error('Error downloading file:', error);
    }
  };

  props.onClick = handleDownload;
  props.target = '_blank';

  const domainServerBaseUrl = `${apiBaseUrl()}/api`;

  return (
    <a
      href={
        filepath?.startsWith('files/')
          ? `${domainServerBaseUrl}/${filepath}`
          : `${domainServerBaseUrl}/files/${filepath}`
      }
      {...props}
    >
      {children}
    </a>
  );
});
a.displayName = 'MarkdownAnchor';

type TParagraphProps = {
  children: React.ReactNode;
};

export const p: React.ElementType = memo(function MarkdownParagraph({ children }: TParagraphProps) {
  return <p className="mb-2 whitespace-pre-wrap">{children}</p>;
});
p.displayName = 'MarkdownParagraph';

type TTableProps = {
  children: React.ReactNode;
};

export const table: React.ElementType = memo(function MarkdownTable({ children }: TTableProps) {
  return (
    <div className="markdown-table-wrapper w-full max-w-full">
      <table>{children}</table>
    </div>
  );
});
table.displayName = 'MarkdownTable';

type TImageProps = {
  src?: string;
  alt?: string;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
};

export const img: React.ElementType = memo(function MarkdownImage({
  src,
  alt,
  title,
  className,
  style,
}: TImageProps) {
  // Get the base URL from the API endpoints
  const baseURL = apiBaseUrl();

  // If src starts with /images/, prepend the base URL
  const fixedSrc = useMemo(() => {
    if (!src) return src;

    // If it's already an absolute URL or doesn't start with /images/, return as is
    if (src.startsWith('http') || src.startsWith('data:') || !src.startsWith('/images/')) {
      return src;
    }

    // Prepend base URL to the image path
    return `${baseURL}${src}`;
  }, [src, baseURL]);

  if (isVideoUrl(fixedSrc)) {
    return <InlineVideo src={fixedSrc as string} label={alt} />;
  }

  if (isAudioUrl(fixedSrc)) {
    return <InlineAudio src={fixedSrc as string} label={alt} />;
  }

  return <img src={fixedSrc} alt={alt} title={title} className={className} style={style} />;
});
img.displayName = 'MarkdownImage';
