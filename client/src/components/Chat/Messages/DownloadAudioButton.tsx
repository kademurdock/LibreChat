import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRecoilValue } from 'recoil';
import { Download, Loader } from 'lucide-react';
import { useToastContext } from '@librechat/client';
import { useTextToSpeechMutation } from '~/data-provider';
import { TTSEndpoints } from '~/common';
import store from '~/store';

type RenderProps = {
  onClick: () => void;
  title: string;
  icon: ReactNode;
  isDisabled: boolean;
};

/**
 * Save or share the AI reply's TTS audio (Kade, July 2026).
 *
 * Fetches the same external-TTS audio the read-aloud button plays, then hands
 * it to the platform: on devices that support sharing a file (iPhone/iPad,
 * Android) it opens the native share sheet (Messages, Save to Files, etc.); on
 * desktop it falls back to a plain file download. Only rendered for the
 * external TTS engine, since browser/device TTS produces no shareable file.
 */
async function shareOrDownload(blob: Blob, filename: string): Promise<void> {
  const nav = navigator as Navigator & {
    canShare?: (data?: { files?: File[] }) => boolean;
    share?: (data?: { files?: File[]; title?: string }) => Promise<void>;
  };
  try {
    const file = new File([blob], filename, { type: 'audio/mpeg' });
    if (nav.canShare?.({ files: [file] }) === true && nav.share) {
      await nav.share({ files: [file], title: filename });
      return;
    }
  } catch {
    /* share cancelled or unsupported (e.g. iOS activation lost) -> download */
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export default function DownloadAudioButton({
  content,
  renderButton,
}: {
  content: string;
  renderButton: (props: RenderProps) => ReactNode;
}) {
  const { showToast } = useToastContext();
  const engineTTS = useRecoilValue<string>(store.engineTTS);
  const voice = useRecoilValue(store.voice);
  const voiceSpeed = useRecoilValue(store.voiceSpeed);
  const [loading, setLoading] = useState(false);

  const { mutate } = useTextToSpeechMutation({
    onSuccess: async (data: ArrayBuffer) => {
      try {
        await shareOrDownload(new Blob([data], { type: 'audio/mpeg' }), 'voice-clip.mp3');
      } catch (e) {
        showToast({ message: `Could not save clip: ${(e as Error).message}`, status: 'error' });
      } finally {
        setLoading(false);
      }
    },
    onError: (error: unknown) => {
      setLoading(false);
      showToast({ message: `Could not generate clip: ${(error as Error).message}`, status: 'error' });
    },
  });

  if (engineTTS !== TTSEndpoints.external) {
    return null;
  }

  const onClick = () => {
    if (loading || !content) {
      return;
    }
    setLoading(true);
    const formData = new FormData();
    formData.append('input', content);
    formData.append('voice', voice ?? '');
    if (typeof voiceSpeed === 'number') {
      formData.append('speed', String(voiceSpeed));
    }
    mutate(formData);
  };

  return (
    <>
      {renderButton({
        onClick,
        title: loading ? 'Preparing voice clip…' : 'Save / share voice clip',
        icon: loading ? (
          <Loader className="h-[18px] w-[18px] animate-spin" aria-hidden="true" />
        ) : (
          <Download className="h-[18px] w-[18px]" aria-hidden="true" />
        ),
        isDisabled: loading,
      })}
    </>
  );
}
