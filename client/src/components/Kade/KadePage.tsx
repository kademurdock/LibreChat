import { useForm } from 'react-hook-form';
import type { ReactNode } from 'react';
import type { ChatFormValues } from '~/common';
import { ChatContext, ChatFormProvider, ActivePanelProvider } from '~/Providers';
import { useChatHelpers } from '~/hooks';

/**
 * KADE Part 116.6 (Sep 2 2026) — PANELS BECOME PAGES.
 *
 * Her words: "I wish the sidebar didn't have to exist at all… Settings, agent
 * builder, lots of useful things that are hard to find, hard to access
 * because they're hidden." LibreChat keeps the Agent Builder, Bookmarks,
 * Memories and Files as PANELS — widgets that only render inside the left
 * drawer — which is the only reason the drawer had to exist. Those
 * components do not depend on the drawer; they depend on two contexts the
 * drawer happened to provide (a chat context for index 0 and the active-panel
 * context). This frame provides both, so the same components render as
 * full-width pages at /agent-builder, /bookmarks, /memories, /files, each
 * with a real heading and a way back to Home. The drawer is then removed
 * from the chat screen entirely — deleted, not hidden.
 */
function KadePageProviders({ children }: { children: ReactNode }) {
  const chatHelpers = useChatHelpers(0);
  const formMethods = useForm<ChatFormValues>({ defaultValues: { text: '' } });
  return (
    <ChatFormProvider {...formMethods}>
      <ChatContext.Provider value={chatHelpers}>
        <ActivePanelProvider>{children}</ActivePanelProvider>
      </ChatContext.Provider>
    </ChatFormProvider>
  );
}

export default function KadePage({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <KadePageProviders>
      <main
        className="text-text-primary"
        style={{ height: '100%', overflowY: 'auto', padding: '16px 20px 40px' }}
        aria-labelledby="kade-page-title"
      >
        <div style={{ maxWidth: 880, margin: '0 auto' }}>
          <a href="/home" style={{ display: 'inline-block', marginBottom: 4, fontWeight: 600, textDecoration: 'none' }}>
            &larr; Home
          </a>
          <h1 id="kade-page-title" style={{ fontSize: '1.6rem', margin: '0 0 4px' }}>
            {title}
          </h1>
          {intro ? <p style={{ opacity: 0.75, marginTop: 0 }}>{intro}</p> : null}
          <div className="kade-page-body">{children}</div>
        </div>
      </main>
    </KadePageProviders>
  );
}
