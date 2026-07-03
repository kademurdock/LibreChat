import { useState, memo, useRef } from 'react';
import { useSetRecoilState } from 'recoil';
import * as Menu from '@ariakit/react/menu';
import { GearIcon, DropdownMenuSeparator, Avatar } from '@librechat/client';
import {
  Archive,
  ChevronRight,
  CircleHelp,
  Compass,
  Clapperboard,
  Dices,
  FileText,
  Gauge,
  Heart,
  Landmark,
  MessagesSquare,
  Trophy,
  Keyboard,
  LifeBuoy,
  LogOut,
  Scale,
  ShieldCheck,
} from 'lucide-react';
import { SystemRoles } from 'librechat-data-provider';
import { ArchivedChatsModal } from '~/components/Nav/SettingsTabs/General/ArchivedChatsModal';
import { MyFilesModal } from '~/components/Chat/Input/Files/MyFilesModal';
import { useGetStartupConfig, useGetUserBalance } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import { useLocalize } from '~/hooks';
import Settings from './Settings';
import store from '~/store';

function HelpSubmenu({
  helpAndFaqURL,
  termsOfServiceURL,
  privacyPolicyURL,
  onShowShortcuts,
}: {
  helpAndFaqURL?: string;
  termsOfServiceURL?: string;
  privacyPolicyURL?: string;
  onShowShortcuts: () => void;
}) {
  const localize = useLocalize();
  const hasHelpFaq = !!helpAndFaqURL && helpAndFaqURL !== '/';
  const hasTos = !!termsOfServiceURL;
  const hasPrivacy = !!privacyPolicyURL;
  const showLegalDivider = (hasHelpFaq || true) && (hasTos || hasPrivacy);

  return (
    <Menu.MenuProvider placement="right-start">
      <Menu.MenuItem
        hideOnClick={false}
        render={
          <Menu.MenuButton className="select-item flex w-full cursor-pointer items-center gap-2 text-sm" />
        }
      >
        <CircleHelp className="icon-md" aria-hidden="true" />
        <span className="flex-1 text-left">{localize('com_nav_help')}</span>
        <ChevronRight className="h-4 w-4 text-text-secondary" aria-hidden="true" />
      </Menu.MenuItem>
      <Menu.Menu
        portal
        gutter={12}
        className="account-settings-popover popover-ui popover-from-left z-[126] w-[244px] rounded-lg"
      >
        {hasHelpFaq && (
          <Menu.MenuItem
            onClick={() => window.open(helpAndFaqURL, '_blank', 'noopener,noreferrer')}
            className="select-item text-sm"
          >
            <LifeBuoy className="icon-md" aria-hidden="true" />
            {localize('com_nav_help_faq')}
          </Menu.MenuItem>
        )}
        <Menu.MenuItem onClick={onShowShortcuts} className="select-item text-sm">
          <Keyboard className="icon-md" aria-hidden="true" />
          {localize('com_shortcut_keyboard_shortcuts')}
        </Menu.MenuItem>
        {showLegalDivider && (hasTos || hasPrivacy) && <DropdownMenuSeparator />}
        {hasTos && (
          <Menu.MenuItem
            onClick={() => window.open(termsOfServiceURL, '_blank', 'noopener,noreferrer')}
            className="select-item text-sm"
          >
            <Scale className="icon-md" aria-hidden="true" />
            {localize('com_ui_terms_of_service')}
          </Menu.MenuItem>
        )}
        {hasPrivacy && (
          <Menu.MenuItem
            onClick={() => window.open(privacyPolicyURL, '_blank', 'noopener,noreferrer')}
            className="select-item text-sm"
          >
            <ShieldCheck className="icon-md" aria-hidden="true" />
            {localize('com_ui_privacy_policy')}
          </Menu.MenuItem>
        )}
      </Menu.Menu>
    </Menu.MenuProvider>
  );
}

/** KADE July 3 2026: the fun pages were piling up as flat items in the account
 * menu (Kade: "a lot stuffed into it that aren't account and settings related").
 * One Explore submenu, same accessible pattern as HelpSubmenu. */
function ExploreSubmenu({ isAdmin, isChild }: { isAdmin: boolean; isChild: boolean }) {
  const go = (href: string) => () => {
    window.location.href = href;
  };
  return (
    <Menu.MenuProvider placement="right-start">
      <Menu.MenuItem
        hideOnClick={false}
        render={
          <Menu.MenuButton className="select-item flex w-full cursor-pointer items-center gap-2 text-sm" />
        }
      >
        <Compass className="icon-md" aria-hidden="true" />
        <span className="flex-1 text-left">Explore</span>
        <ChevronRight className="h-4 w-4 text-text-secondary" aria-hidden="true" />
      </Menu.MenuItem>
      <Menu.Menu
        portal
        gutter={12}
        className="account-settings-popover popover-ui popover-from-left z-[126] w-[244px] rounded-lg"
      >
        <Menu.MenuItem
          onClick={go('/debate-room')}
          className="select-item text-sm"
          aria-label="Debate Room: put two or more characters in a room with a topic and join in"
        >
          <MessagesSquare className="icon-md" aria-hidden="true" />
          Debate Room
        </Menu.MenuItem>
        <Menu.MenuItem
          onClick={go('/game-room')}
          className="select-item text-sm"
          aria-label="Game Room: the Game Parlor leaderboard — family standings, records, and latest results"
        >
          <Dices className="icon-md" aria-hidden="true" />
          Game Room
        </Menu.MenuItem>
        {!isChild && (
          <Menu.MenuItem
            onClick={go('/conversation-hall')}
            className="select-item text-sm"
            aria-label="Conversation Hall: the greatest hits people have shared from the Debate Room"
          >
            <Landmark className="icon-md" aria-hidden="true" />
            Conversation Hall
          </Menu.MenuItem>
        )}
        <Menu.MenuItem
          onClick={go('/wall-of-fame')}
          className="select-item text-sm"
          aria-label="Wall of Fame: creations everyone has chosen to share"
        >
          <Trophy className="icon-md" aria-hidden="true" />
          Wall of Fame
        </Menu.MenuItem>
        <Menu.MenuItem
          onClick={go('/my-creations')}
          className="select-item text-sm"
          aria-label="My Creations: every video and image you've generated, with descriptions and downloads"
        >
          <Clapperboard className="icon-md" aria-hidden="true" />
          My Creations
        </Menu.MenuItem>
        <Menu.MenuItem
          onClick={go('/feed-the-server')}
          className="select-item text-sm"
          aria-label="Feed the Server: see what you've used and chip in"
        >
          <Heart className="icon-md" aria-hidden="true" />
          Feed the Server
        </Menu.MenuItem>
        {isAdmin && (
          <Menu.MenuItem
            onClick={go('/usage-dashboard')}
            className="select-item text-sm"
            aria-label="Usage dashboard (admin only)"
          >
            <Gauge className="icon-md" aria-hidden="true" />
            Usage Dashboard
          </Menu.MenuItem>
        )}
      </Menu.Menu>
    </Menu.MenuProvider>
  );
}

function AccountSettings({ collapsed = false }: { collapsed?: boolean }) {
  const localize = useLocalize();
  const { user, isAuthenticated, logout } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();
  const balanceQuery = useGetUserBalance({
    enabled: !!isAuthenticated && startupConfig?.balance?.enabled,
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const setShowShortcutsDialog = useSetRecoilState(store.showShortcutsDialog);
  const [showArchived, setShowArchived] = useState(false);
  const accountSettingsButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <Menu.MenuProvider placement={collapsed ? 'right-end' : undefined}>
      <Menu.MenuButton
        ref={accountSettingsButtonRef}
        aria-label={localize('com_nav_account_settings')}
        data-testid="nav-user"
        className={
          collapsed
            ? 'flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-surface-active-alt aria-[expanded=true]:bg-surface-active-alt'
            : 'mt-text-sm flex h-auto w-full items-center gap-2 rounded-xl p-2 text-sm transition-all duration-200 ease-in-out hover:bg-surface-active-alt aria-[expanded=true]:bg-surface-active-alt'
        }
      >
        <div
          className={collapsed ? 'size-7 flex-shrink-0' : '-ml-0.9 -mt-0.8 h-8 w-8 flex-shrink-0'}
        >
          <div className="relative flex">
            <Avatar user={user} size={collapsed ? 28 : 32} />
          </div>
        </div>
        {!collapsed && (
          <div
            className="mt-2 grow overflow-hidden text-ellipsis whitespace-nowrap text-left text-text-primary"
            style={{ marginTop: '0', marginLeft: '0' }}
          >
            {user?.name ?? user?.username ?? localize('com_nav_user')}
          </div>
        )}
      </Menu.MenuButton>
      <Menu.Menu
        portal
        className="account-settings-popover popover-ui z-[125] w-[305px] rounded-lg md:w-[244px]"
        style={{
          transformOrigin: collapsed ? 'left bottom' : 'bottom',
          translate: collapsed ? '4px 0' : '0 -4px',
        }}
      >
        <div className="text-token-text-secondary ml-3 mr-2 py-2 text-sm" role="note">
          {user?.email ?? localize('com_nav_user')}
        </div>
        <DropdownMenuSeparator />
        {startupConfig?.balance?.enabled === true && balanceQuery.data != null && (
          <>
            <div className="text-token-text-secondary ml-3 mr-2 py-2 text-sm" role="note">
              {localize('com_nav_balance')}:{' '}
              {new Intl.NumberFormat().format(Math.round(balanceQuery.data.tokenCredits))}
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        <HelpSubmenu
          helpAndFaqURL={startupConfig?.helpAndFaqURL}
          termsOfServiceURL={startupConfig?.interface?.termsOfService?.externalUrl}
          privacyPolicyURL={startupConfig?.interface?.privacyPolicy?.externalUrl}
          onShowShortcuts={() => setShowShortcutsDialog(true)}
        />
        <Menu.MenuItem onClick={() => setShowFiles(true)} className="select-item text-sm">
          <FileText className="icon-md" aria-hidden="true" />
          {localize('com_nav_my_files')}
        </Menu.MenuItem>
        <Menu.MenuItem onClick={() => setShowArchived(true)} className="select-item text-sm">
          <Archive className="icon-md" aria-hidden="true" />
          {localize('com_nav_archived_chats')}
        </Menu.MenuItem>
        <Menu.MenuItem
          onClick={() => setShowSettings(true)}
          className="select-item text-sm"
          data-testid="nav-settings"
        >
          <GearIcon className="icon-md" aria-hidden="true" />
          {localize('com_nav_settings')}
        </Menu.MenuItem>
        <DropdownMenuSeparator />
        <ExploreSubmenu
          isAdmin={user?.role === SystemRoles.ADMIN}
          isChild={(user as { kadeAccountType?: string } | undefined)?.kadeAccountType === 'child'}
        />
        <DropdownMenuSeparator />
        <Menu.MenuItem onClick={() => logout()} className="select-item text-sm">
          <LogOut className="icon-md" aria-hidden="true" />
          {localize('com_nav_log_out')}
        </Menu.MenuItem>
      </Menu.Menu>
      {showFiles && (
        <MyFilesModal
          open={showFiles}
          onOpenChange={setShowFiles}
          triggerRef={accountSettingsButtonRef}
        />
      )}
      {showArchived && (
        <ArchivedChatsModal
          open={showArchived}
          onOpenChange={setShowArchived}
          triggerRef={accountSettingsButtonRef}
        />
      )}
      {showSettings && <Settings open={showSettings} onOpenChange={setShowSettings} />}
    </Menu.MenuProvider>
  );
}

export default memo(AccountSettings);
