import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { useSpeechToTextMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';

export default function DictateButton({
  onTranscript,
  disabled = false,
  active = true,
}: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  active?: boolean;
}) {
  const localize = useLocalize();
  const statusId = useId();
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle');
  const [status, setStatus] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const append = useRef(onTranscript);
  append.current = onTranscript;
  const { mutateAsync } = useSpeechToTextMutation();

  const cancel = useCallback(() => {
    generation.current++;
    clearTimeout(timer.current);
    const current = recorder.current;
    recorder.current = null;
    if (current) {
      current.onstop = null;
      if (current.state === 'recording') current.stop();
      current.stream.getTracks().forEach((track) => track.stop());
    }
    busy.current = false;
  }, []);

  useEffect(() => {
    if (!active || disabled) {
      cancel();
      setPhase('idle');
    }
    return cancel;
  }, [active, disabled, cancel]);

  async function start() {
    if (busy.current) return;
    busy.current = true;
    const attempt = ++generation.current;
    setPhase('starting');
    setStatus('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (attempt !== generation.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      let current: MediaRecorder;
      try {
        current = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      } catch (error) {
        stream.getTracks().forEach((track) => track.stop());
        throw error;
      }
      recorder.current = current;
      const chunks: Blob[] = [];
      current.onerror = () => {
        if (attempt !== generation.current) return;
        cancel();
        setPhase('idle');
        setStatus(localize('com_ui_dictation_error'));
      };
      current.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      current.onstop = async () => {
        clearTimeout(timer.current);
        stream.getTracks().forEach((track) => track.stop());
        recorder.current = null;
        if (attempt !== generation.current) return;
        setPhase('transcribing');
        try {
          const audio = new Blob(chunks, { type: current.mimeType });
          if (!audio.size) throw new Error('empty');
          const form = new FormData();
          form.append(
            'audio',
            audio,
            current.mimeType.includes('mp4') ? 'dictation.m4a' : 'dictation.webm',
          );
          const result = await mutateAsync(form);
          if (attempt !== generation.current) return;
          if (!result.text.trim()) throw new Error('empty');
          append.current(result.text.trim());
          setStatus(localize('com_ui_dictation_added'));
        } catch {
          if (attempt === generation.current) setStatus(localize('com_ui_dictation_error'));
        } finally {
          if (attempt === generation.current) {
            busy.current = false;
            setPhase('idle');
          }
        }
      };
      current.start();
      setPhase('recording');
      timer.current = setTimeout(() => {
        if (current.state === 'recording') current.stop();
      }, 120000);
    } catch {
      if (attempt === generation.current) {
        cancel();
        setPhase('idle');
        setStatus(localize('com_ui_dictation_error'));
      }
    }
  }

  const label =
    phase === 'recording'
      ? 'com_ui_dictation_stop'
      : phase === 'transcribing'
        ? 'com_ui_dictation_working'
        : 'com_ui_dictate';
  return (
    <div className="space-y-1">
      <button
        type="button"
        className="flex min-h-11 items-center gap-2 rounded-md border border-border-medium px-3 py-2 text-sm focus-visible:ring-2"
        disabled={disabled || !active || phase === 'starting' || phase === 'transcribing'}
        aria-pressed={phase === 'recording'}
        aria-describedby={statusId}
        onClick={() => {
          if (phase === 'recording') {
            if (recorder.current?.state === 'recording') recorder.current.stop();
          } else void start();
        }}
      >
        {phase === 'recording' ? <Square size={16} aria-hidden /> : <Mic size={16} aria-hidden />}
        {localize(label)}
      </button>
      <p id={statusId} className="text-xs text-text-secondary" role="status">
        {phase === 'recording'
          ? localize('com_ui_dictation_recording')
          : phase === 'transcribing'
            ? localize('com_ui_dictation_working')
            : status || localize('com_ui_dictation_hint')}
      </p>
    </div>
  );
}
