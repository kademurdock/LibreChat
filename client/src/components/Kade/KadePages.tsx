import { useNavigate } from 'react-router-dom';
import AgentPanelSwitch from '~/components/SidePanel/Agents/AgentPanelSwitch';
import BookmarkPanel from '~/components/SidePanel/Bookmarks/BookmarkPanel';
import { MemoryPanel } from '~/components/SidePanel/Memories';
import FilesPanel from '~/components/SidePanel/Files/Panel';
import Settings from '~/components/Nav/Settings';
import KadePage from './KadePage';

/* Part 116.6 — the former side-panel widgets as full pages. Titles and intros
 * are the native app's spoken labels and hints, same as /home. */

export function AgentBuilderPage() {
  return (
    <KadePage title="Agent Builder" intro="Create or edit your own companions.">
      <AgentPanelSwitch />
    </KadePage>
  );
}

export function BookmarksPage() {
  return (
    <KadePage
      title="Bookmarks"
      intro="Your tagged conversations, gathered by bookmark — tag any conversation from the conversation list."
    >
      <BookmarkPanel />
    </KadePage>
  );
}

export function MemoriesPage() {
  return (
    <KadePage title="Memories" intro="The cards your companions keep about you. Read, edit, or delete any of them.">
      <MemoryPanel />
    </KadePage>
  );
}

export function FilesPage() {
  return (
    <KadePage title="Files" intro="Everything you have uploaded, and what each companion can read.">
      <FilesPanel />
    </KadePage>
  );
}

/** /settings — the Settings dialog, opened on a page of its own; closing it
 * goes back Home instead of dropping you into a chat you did not ask for. */
export function SettingsPage() {
  const navigate = useNavigate();
  return (
    <KadePage title="Settings" intro="Speech, accessibility, and pronunciation dictionary settings.">
      <Settings
        open={true}
        onOpenChange={(open: boolean) => {
          if (!open) {
            navigate('/home');
          }
        }}
      />
      <p style={{ opacity: 0.75 }}>
        The settings window is open. Close it to return Home, or{' '}
        <a href="/pronunciation-dictionary">open the pronunciation dictionary</a>.
      </p>
    </KadePage>
  );
}
