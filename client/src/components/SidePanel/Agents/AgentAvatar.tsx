import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useToastContext } from '@librechat/client';
import { useFormContext, useWatch } from 'react-hook-form';
import { mergeFileConfig, fileConfig as defaultFileConfig } from 'librechat-data-provider';
import type { AgentAvatar } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { AgentAvatarRender, NoImage, AvatarMenu } from './Images';
import { useGetFileConfig } from '~/data-provider';
import { useLocalize, useAuthContext } from '~/hooks';

function Avatar({ avatar }: { avatar: AgentAvatar | null }) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { token } = useAuthContext();
  const { control, setValue } = useFormContext<AgentForm>();
  const avatarPreview = useWatch({ control, name: 'avatar_preview' }) ?? '';
  const avatarAction = useWatch({ control, name: 'avatar_action' });
  /* KADE (July 2 2026): AI avatar generator — profile pics for agents right
   * in the builder. Pre-fills a portrait prompt from the agent's name and
   * description; the user can edit it before generating (~3 cents via the
   * existing BFL credits, logged to kadeusage like any flux image). The
   * result lands in the normal avatar form flow (preview first — nothing
   * is committed until the agent is saved). */
  const agentName = useWatch({ control, name: 'name' }) ?? '';
  const agentDescription = useWatch({ control, name: 'description' }) ?? '';
  const [genOpen, setGenOpen] = useState(false);
  const [genPrompt, setGenPrompt] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState('');
  const genTextareaRef = useRef<HTMLTextAreaElement>(null);

  const openGenerate = useCallback(() => {
    const bits = [
      'Head-and-shoulders portrait avatar of',
      agentName ? `${String(agentName).trim()},` : 'this character,',
      agentDescription ? `${String(agentDescription).trim()}.` : '',
      'Vibrant, friendly, expressive face, centered composition, clean simple background, no text or logos.',
    ].filter(Boolean);
    setGenPrompt(bits.join(' '));
    setGenError('');
    setGenOpen(true);
    setTimeout(() => genTextareaRef.current?.focus(), 60);
  }, [agentName, agentDescription]);

  const handleGenerate = useCallback(async () => {
    if (genBusy) {
      return;
    }
    setGenBusy(true);
    setGenError('');
    try {
      const resp = await fetch('/api/kade/avatar-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: genPrompt }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data?.error || `Generation failed (${resp.status})`);
      }
      const blob = await (await fetch(data.image)).blob();
      const file = new File([blob], 'generated-avatar.png', { type: blob.type || 'image/png' });
      setValue('avatar_file', file, { shouldDirty: true });
      setValue('avatar_preview', data.image, { shouldDirty: true });
      setValue('avatar_action', 'upload', { shouldDirty: true });
      setGenOpen(false);
      showToast({ message: 'Avatar generated — save the agent to keep it.', status: 'success' });
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Generation failed. Try again.');
    } finally {
      setGenBusy(false);
    }
  }, [genBusy, genPrompt, token, setValue, showToast]);
  const { data: fileConfig = defaultFileConfig } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });

  // Derive whether agent has a remote avatar from the avatar prop
  const hasRemoteAvatar = Boolean(avatar?.filepath);

  useEffect(() => {
    if (avatarAction) {
      return;
    }

    if (avatar?.filepath && avatarPreview !== avatar.filepath) {
      setValue('avatar_preview', avatar.filepath);
    }

    if (!avatar?.filepath && avatarPreview !== '') {
      setValue('avatar_preview', '');
    }
  }, [avatar?.filepath, avatarAction, avatarPreview, setValue]);

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      const sizeLimit = fileConfig.avatarSizeLimit ?? 0;

      if (!file) {
        return;
      }

      if (sizeLimit && file.size > sizeLimit) {
        const limitInMb = sizeLimit / (1024 * 1024);
        const displayLimit = Number.isInteger(limitInMb)
          ? limitInMb
          : parseFloat(limitInMb.toFixed(1));
        showToast({
          message: localize('com_ui_upload_invalid_var', { 0: displayLimit }),
          status: 'error',
        });
        return;
      }

      const reader = new FileReader();
      reader.onloadend = () => {
        setValue('avatar_file', file, { shouldDirty: true });
        setValue('avatar_preview', (reader.result as string) ?? '', { shouldDirty: true });
        setValue('avatar_action', 'upload', { shouldDirty: true });
      };
      reader.readAsDataURL(file);
    },
    [fileConfig.avatarSizeLimit, localize, setValue, showToast],
  );

  const handleReset = useCallback(() => {
    const remoteAvatarExists = Boolean(avatar?.filepath);
    setValue('avatar_preview', '', { shouldDirty: true });
    setValue('avatar_file', null, { shouldDirty: true });
    setValue('avatar_action', remoteAvatarExists ? 'reset' : null, { shouldDirty: true });
  }, [avatar?.filepath, setValue]);

  const hasIcon = Boolean(avatarPreview) || hasRemoteAvatar;
  const canReset = hasIcon;

  return (
    <>
      <div className="flex w-full items-center justify-center gap-4">
        <AvatarMenu
          trigger={
            <button
              type="button"
              className="f h-20 w-20 outline-none ring-offset-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={localize('com_ui_upload_agent_avatar_label')}
            >
              {avatarPreview ? <AgentAvatarRender url={avatarPreview} /> : <NoImage />}
            </button>
          }
          handleFileChange={handleFileChange}
          onReset={handleReset}
          canReset={canReset}
          onGenerate={openGenerate}
        />
      </div>
      {genOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Generate an avatar with AI"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !genBusy) {
              e.preventDefault();
              setGenOpen(false);
            }
          }}
        >
          <div className="w-full max-w-md rounded-2xl bg-surface-primary p-4 shadow-xl">
            <h2 className="mb-1 text-base font-semibold text-text-primary">Generate an avatar</h2>
            <p className="mb-2 text-sm text-text-secondary">
              Describe the profile picture — pre-filled from this agent&apos;s name and description.
              Costs about 3 cents; spend shows on the Feed the Server page.
            </p>
            <textarea
              ref={genTextareaRef}
              className="mb-2 h-32 w-full resize-y rounded-lg border border-border-medium bg-surface-secondary p-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label="Avatar description"
              value={genPrompt}
              onChange={(e) => setGenPrompt(e.target.value)}
              disabled={genBusy}
            />
            <div aria-live="polite" className="mb-2 min-h-5 text-sm">
              {genBusy && <span className="text-text-secondary">Generating your avatar — this takes about ten seconds…</span>}
              {!genBusy && genError && <span className="text-red-500">{genError}</span>}
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-border-medium px-3 py-2 text-sm text-text-primary hover:bg-surface-tertiary"
                onClick={() => setGenOpen(false)}
                disabled={genBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
                onClick={handleGenerate}
                disabled={genBusy || genPrompt.trim().length < 3}
                aria-busy={genBusy}
              >
                {genBusy ? 'Generating…' : 'Generate (~3¢)'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const MemoizedAvatar = memo(
  Avatar,
  (prevProps, nextProps) => prevProps.avatar?.filepath === nextProps.avatar?.filepath,
);
MemoizedAvatar.displayName = 'Avatar';

export default MemoizedAvatar;
