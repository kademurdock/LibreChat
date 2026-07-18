import { useState, useEffect } from 'react';
import { useRecoilValue } from 'recoil';
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
function KadeTabBar() {
  const tabs = [
    { key: 'chats', href: '/', label: 'Chats', icon: '\uD83D\uDCAC' },
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
      {tabs.map((t) => (
        <a
          key={t.key}
          href={t.href}
          aria-current={t.key === 'chats' ? 'page' : undefined}
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 3,
            textDecoration: 'none',
            fontSize: '0.72rem',
            fontWeight: 600,
            color: t.key === 'chats' ? '#6ea8ff' : 'var(--text-secondary, #9aa3b5)',
          }}
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

  const { isAuthenticated, logout } = useAuthContext();

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
              <div className="flex" style={{ height: `calc(100dvh - ${bannerHeight}px${isSmallScreen ? ' - 64px - env(safe-area-inset-bottom, 0px)' : ''})` }}>
                <div className="relative z-0 flex h-full w-full overflow-hidden">
                  <UnifiedSidebar />
                  <div
                    className="relative flex h-full max-w-full flex-1 flex-col overflow-hidden"
                    style={{
                      transform:
                        isSmallScreen && sidebarExpanded ? 'translateX(min(85vw, 380px))' : 'none',
                      transition: 'transform 300ms cubic-bezier(0.2, 0, 0, 1)',
                    }}
                    inert={isSmallScreen && sidebarExpanded ? '' : undefined}
                  >
                    <Outlet />
                  </div>
                </div>
              </div>
              {isSmallScreen && <KadeTabBar />}
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
