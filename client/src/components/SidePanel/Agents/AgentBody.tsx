import { useState } from 'react';
import {
  Button,
  OGDialog,
  OGDialogTitle,
  OGDialogContent,
  OGDialogTrigger,
  OGDialogDescription,
} from '@librechat/client';
import { useAgentBodyQuery } from '~/data-provider';
import { preparedPortrait } from '~/components/Chat/character/portrait-rig.mjs';
import AgentBodyEditor from './AgentBodyEditor';
import { useLocalize } from '~/hooks';

/**
 * KADE Oct 16 2026 — the "Body" section of the agent builder: what the character's
 * puppet body looks like in words, and the button that opens the body editor. Shown only
 * for a saved agent the person can edit (the builder renders AgentConfig only then).
 */
export default function AgentBody({
  agentId,
  agentName,
  avatarPath,
}: {
  agentId: string;
  agentName: string;
  avatarPath: string;
}) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const { data: body } = useAgentBodyQuery(agentId);
  const handMade = !!avatarPath && !!preparedPortrait(agentId, avatarPath);
  return (
    <div className="mb-4">
      <h3 className="text-token-text-primary mb-2 block text-sm font-medium">
        {localize('com_ui_body')}
      </h3>
      <p className="mb-2 line-clamp-3 text-xs leading-relaxed text-text-secondary">
        {body?.description || localize('com_ui_body_none')}
      </p>
      {handMade && (
        <p className="mb-2 text-xs text-text-secondary">{localize('com_ui_body_handmade_note')}</p>
      )}
      <OGDialog open={open} onOpenChange={setOpen}>
        <OGDialogTrigger asChild>
          <Button type="button" variant="outline" className="min-h-[44px] w-full">
            {body?.recipe ? localize('com_ui_body_edit') : localize('com_ui_body_create')}
          </Button>
        </OGDialogTrigger>
        {open && (
          <OGDialogContent className="w-11/12 max-w-2xl motion-reduce:!animate-none">
            <OGDialogTitle className="pr-8 text-lg font-semibold">
              {localize('com_ui_body_editor_title', { 0: agentName || localize('com_ui_agent') })}
            </OGDialogTitle>
            <OGDialogDescription className="text-sm text-text-secondary">
              {localize('com_ui_body_help')}
            </OGDialogDescription>
            <AgentBodyEditor agentId={agentId} hasPortrait={!!avatarPath} />
          </OGDialogContent>
        )}
      </OGDialog>
    </div>
  );
}
