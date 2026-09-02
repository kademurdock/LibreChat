import { useState, useEffect } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { Outlet } from 'react-router-dom';
import { useMediaQuery } from '@librechat/client';
import {
  PromptGroupsProvider,
  AssistantsMapContext,
  AgentsMapContext,
  SetConvoProvider,
  FileMapContext,
} from '~/Providers';
import {
  useSearchEnabled,
  useAssistantsMap,
  useAuthContext,
  useAgentsMap,
  useFileMap,
} from '~/hooks';
import KeyboardShortcutsDialog from '~/components/Nav/KeyboardShortcutsDialog';
import Settings from '~/components/Nav/Settings';
import KeyboardDeleteDialog from '~/components/Nav/KeyboardDeleteDialog';
import { useUserTermsQuery, useGetStartupConfig } from '~/data-provider';
import useKeyboardShortcuts from '~/hooks/useKeyboardShortcuts';
import { UnifiedSidebar } from '~/components/UnifiedSidebar';
import { TermsAndConditionsModal } from '~/components/ui';
import { useHealthCheck } from '~/data-provider';
import { Banner } from '~/components/Banners';
import store from '~/store';

/** Isolates keyboard shortcut listeners so they only mount after auth. */
function KeyboardShortcutsProvider() {
  useKeyboardShortcuts();
  return (
    <>
      <KeyboardShortcutsDialog />
      <KeyboardDeleteDialog />
    </>
  );
}

/** KADE July 18 2026 — native-style bottom tab bar (mobile only). Unifies
 *  navigation so destinations no longer hide in a nested account submenu:
 *  Chats / Tools / Alerts / You, always one tap away. Tools/Alerts/You are the
 *  server-rendered hub pages, reached by full navigation like the account menu's
 *  existing links. Rendered only on small screens; desktop is unchanged. */
/* KADE Part 116.3 (Sep 2 2026) — the Home strip. Her words: "it's hard to
 * find things" on the web because the side panels change with context. The
 * fix is a HOME LAYER that mirrors the iPhone app's map exactly (/home,
 * server-rendered, kadeHome.js). This strip is the one fixed, first-in-tab-
 * order way onto it from the chat screen on a desktop, where the bottom tab
 * bar does not render. Gated to ADMIN while she tests it live; flipping
 * `homeLayerOn` to everyone is a one-line change. */
/* Part 116.5 hid LibreChat's drawer behind a toggle; Part 116.6 removed it
 * (see the note in Root below). The strip is the chat screen's only nav. */
function KadeHomeStrip() {
  return (
    <div
      role="navigation"
      aria-label="Kade home"
      style={{
        height: 32,
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 12px',
        fontSize: '0.85rem',
        fontWeight: 600,
        borderBottom: '1px solid var(--border-medium, #2c2f37)',
        background: 'var(--surface-primary, #1a1d23)',
        color: 'var(--text-secondary, #9aa3b5)',
      }}
    >
      <a href="/home" style={{ color: '#6ea8ff', textDecoration: 'none' }}>
        <span aria-hidden="true">{'\uD83C\uDFE0 '}</span>Kade Home
      </a>
      <span aria-hidden="true">·</span>
      <a href="/c/new" style={{ color: 'inherit', textDecoration: 'none' }}>
        New chat
      </a>
      <a href="/conversations" style={{ color: 'inherit', textDecoration: 'none' }}>
        Your conversations
      </a>
      <a href="/agent-builder" style={{ color: 'inherit', textDecoration: 'none' }}>
        Agent Builder
      </a>
      <a href="/agents" style={{ color: 'inherit', textDecoration: 'none' }}>
        Marketplace
      </a>
      <a href="/settings" style={{ color: 'inherit', textDecoration: 'none' }}>
        Settings
      </a>
      <a href="/help" style={{ color: 'inherit', textDecoration: 'none' }}>
        Help
      </a>
    </div>
  );
}

function KadeTabBar({ homeLayerOn }: { homeLayerOn: boolean }) {
  // Chats opens the conversation list (full-screen on mobile); the others go to
  // the server-rendered hub pages. Bottom tab bar, small screens only.
  // Part 116.3: with the home layer on, Home comes first and Tools folds into it.
  const setSidebarExpanded = useSetRecoilState(store.sidebarExpanded);
  const itemStyle = {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    textDecoration: 'none',
    fontSize: '0.72rem',
    fontWeight: 600,
    border: 0,
    background: 'transparent',
    cursor: 'pointer',
  };
  const links = homeLayerOn
    ? [
        { key: 'alerts', href: '/notifications', label: 'Alerts', icon: '\uD83D\uDD14' },
        { key: 'you', href: '/you', label: 'You', icon: '\uD83D\uDC64' },
      ]
    : [
        { key: 'tools', href: '/tools', label: 'Tools', icon: '\uD83E\uDDF0' },
        { key: 'alerts', href: '/notifications', label: 'Alerts', icon: '\uD83D\uDD14' },
        { key: 'you', href: '/you', label: 'You', icon: '\uD83D\uDC64' },
      ];
  return (
    <nav
      aria-label="Main navigation"
      style={{
        height: 64,
        flex: '0 0 auto',
        display: 'flex',
        borderTop: '1px solid var(--border-medium, #2c2f37)',
        background: 'var(--surface-primary, #1a1d23)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      {homeLayerOn && (
        <a href="/home" style={{ ...itemStyle, color: 'var(--text-secondary, #9aa3b5)' }}>
          <span aria-hidden="true" style={{ fontSize: '1.4rem', lineHeight: 1 }}>
            {'\uD83C\uDFE0'}
          </span>
          <span>Home</span>
        </a>
      )}
      {homeLayerOn ? (
        <a href="/conversations" aria-label="Chats. Your conversation list." style={{ ...itemStyle, color: '#6ea8ff' }}>
          <span aria-hidden="true" style={{ fontSize: '1.4rem', lineHeight: 1 }}>
            {'\uD83D\uDCAC'}
          </span>
          <span>Chats</span>
        </a>
      ) : (
        <button
          type="button"
          onClick={() => setSidebarExpanded(true)}
          aria-label="Chats. Open your conversation list."
          style={{ ...itemStyle, color: '#6ea8ff' }}
        >
          <span aria-hidden="true" style={{ fontSize: '1.4rem', lineHeight: 1 }}>
            {'\uD83D\uDCAC'}
          </span>
          <span>Chats</span>
        </button>
      )}
      {links.map((t) => (
        <a
          key={t.key}
          href={t.href}
          style={{ ...itemStyle, color: 'var(--text-secondary, #9aa3b5)' }}
        >
          <span aria-hidden="true" style={{ fontSize: '1.4rem', lineHeight: 1 }}>
            {t.icon}
          </span>
          <span>{t.label}</span>
        </a>
      ))}
    </nav>
  );
}

export default function Root() {
  const [showTerms, setShowTerms] = useState(false);
  const [bannerHeight, setBannerHeight] = useState(0);
  const sidebarExpanded = useRecoilValue(store.sidebarExpanded);
  const isSmallScreen = useMediaQuery('(max-width: 768px)');

  const { isAuthenticated, logout, user } = useAuthContext();
  // Part 116.3: the home layer. Admin-only for one hour on Sep 2 2026; her
  // word after walking it live: "It all looks good to me." On for everyone.
  const homeLayerOn = isAuthenticated;
  /* Part 116.6: the drawer is GONE, not hidden. Its widgets are pages now
   * (/agent-builder, /bookmarks, /memories, /files, /settings) and the
   * conversation list is /conversations. Nothing here renders UnifiedSidebar. */
  /* Part 116.4: /settings is a real address. The server 302s it to
   * /c/new?open=settings and this opens the same Settings dialog the account
   * menu opens; closing it strips the param. */
  const [settingsFromUrl, setSettingsFromUrl] = useState<boolean>(() => {
    try {
      return new URLSearchParams(window.location.search).get('open') === 'settings';
    } catch {
      return false;
    }
  });
  const closeSettingsFromUrl = (open: boolean) => {
    if (!open) {
      setSettingsFromUrl(false);
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('open');
        window.history.replaceState(window.history.state, '', url.toString());
      } catch {
        /* cosmetic */
      }
    }
  };

  useHealthCheck(isAuthenticated);

  const assistantsMap = useAssistantsMap({ isAuthenticated });
  const agentsMap = useAgentsMap({ isAuthenticated });
  const fileMap = useFileMap({ isAuthenticated });

  const { data: config } = useGetStartupConfig();
  const { data: termsData } = useUserTermsQuery({
    enabled: isAuthenticated && config?.interface?.termsOfService?.modalAcceptance === true,
  });

  useSearchEnabled(isAuthenticated);

  useEffect(() => {
    if (termsData) {
      setShowTerms(!termsData.termsAccepted);
    }
  }, [termsData]);

  const handleAcceptTerms = () => {
    setShowTerms(false);
  };

  const handleDeclineTerms = () => {
    setShowTerms(false);
    logout('/login?redirect=false');
  };

  if (!isAuthenticated) {
    return null;
  }

  return (
    <SetConvoProvider>
      <FileMapContext.Provider value={fileMap}>
        <AssistantsMapContext.Provider value={assistantsMap}>
          <AgentsMapContext.Provider value={agentsMap}>
            <PromptGroupsProvider>
              <Banner onHeightChange={setBannerHeight} />
              {homeLayerOn && !isSmallScreen && <KadeHomeStrip />}
              <div className="flex" style={{ height: `calc(100dvh - ${bannerHeight}px${isSmallScreen ? ' - 64px - env(safe-area-inset-bottom, 0px)' : ''}${homeLayerOn && !isSmallScreen ? ' - 32px' : ''})` }}>
                <div className="relative z-0 flex h-full w-full overflow-hidden">
                  {!homeLayerOn && <UnifiedSidebar />}
                  <div
                    className="relative flex h-full max-w-full flex-1 flex-col overflow-hidden"
                    style={{
                      transform: 'none',
                      transition: 'transform 300ms cubic-bezier(0.2, 0, 0, 1)',
                    }}
                    // with the drawer gone (homeLayerOn) nothing may ever make the page inert
                    inert={!homeLayerOn && isSmallScreen && sidebarExpanded ? '' : undefined}
                  >
                    <Outlet />
                  </div>
                </div>
              </div>
              {isSmallScreen && <KadeTabBar homeLayerOn={homeLayerOn} />}
              {isAuthenticated && settingsFromUrl && (
                <Settings open={settingsFromUrl} onOpenChange={closeSettingsFromUrl} />
              )}
            </PromptGroupsProvider>
          </AgentsMapContext.Provider>
          {config?.interface?.termsOfService?.modalAcceptance === true && (
            <TermsAndConditionsModal
              open={showTerms}
              onOpenChange={setShowTerms}
              onAccept={handleAcceptTerms}
              onDecline={handleDeclineTerms}
              title={config.interface.termsOfService.modalTitle}
              modalContent={config.interface.termsOfService.modalContent}
            />
          )}
          <KeyboardShortcutsProvider />
        </AssistantsMapContext.Provider>
      </FileMapContext.Provider>
    </SetConvoProvider>
  );
}
