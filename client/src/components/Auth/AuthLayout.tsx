import { ThemeSelector } from '@librechat/client';
import { TStartupConfig } from 'librechat-data-provider';
import { ErrorMessage } from '~/components/Auth/ErrorMessage';
import { TranslationKeys, useLocalize } from '~/hooks';
import SocialLoginRender from './SocialLoginRender';
import { BlinkAnimation } from './BlinkAnimation';
import { HouseAtDuskPicture } from './HouseAtDusk';
import { Banner } from '../Banners';
import Footer from './Footer';

function AuthLayout({
  children,
  header,
  isFetching,
  startupConfig,
  startupConfigError,
  pathname,
  error,
}: {
  children: React.ReactNode;
  header: React.ReactNode;
  isFetching: boolean;
  startupConfig: TStartupConfig | null | undefined;
  startupConfigError: unknown | null | undefined;
  pathname: string;
  error: TranslationKeys | null;
}) {
  const localize = useLocalize();

  const hasStartupConfigError = startupConfigError !== null && startupConfigError !== undefined;
  /* KADE Sep 25 2026: the house on the hill, sign-in and registration only (not 2FA).
   * The page decides this, never the screen: the painting (and its alt text)
   * hides itself where it must. */
  const showHouse =
    !pathname.includes('2fa') && (pathname.includes('login') || pathname.includes('register'));
  const DisplayError = () => {
    if (hasStartupConfigError) {
      return (
        <div className="mx-auto sm:max-w-sm">
          <ErrorMessage>{localize('com_auth_error_login_server')}</ErrorMessage>
        </div>
      );
    } else if (error === 'com_auth_error_invalid_reset_token') {
      return (
        <div className="mx-auto sm:max-w-sm">
          <ErrorMessage>
            {localize('com_auth_error_invalid_reset_token')}{' '}
            <a className="font-semibold text-green-600 hover:underline" href="/forgot-password">
              {localize('com_auth_click_here')}
            </a>{' '}
            {localize('com_auth_to_try_again')}
          </ErrorMessage>
        </div>
      );
    } else if (error != null && error) {
      return (
        <div className="mx-auto sm:max-w-sm">
          <ErrorMessage>{localize(error)}</ErrorMessage>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="relative flex min-h-screen flex-col bg-white dark:bg-gray-900">
      <Banner />
      {/* Part 70.7 (Aug 16 2026, the council's login-page axe finding): the
          logo lived outside every landmark region. A header (banner) is the
          honest home for it — screen readers gain a named region, sighted
          eyes see the identical page. */}
      <header>
        <BlinkAnimation active={isFetching}>
          <div className="mt-6 h-10 w-full bg-cover">
            {/* KADE Sep 25 2026: the two-dot mark (braille K) replaces the LibreChat logo. */}
            <img
              src="/assets/art/kade-braille-mark-navy-v1.svg"
              className="h-full w-full object-contain"
              alt={localize('com_ui_logo', { 0: startupConfig?.appTitle ?? 'LibreChat' })}
            />
          </div>
        </BlinkAnimation>
      </header>
      <DisplayError />
      <div className="absolute bottom-0 left-0 md:m-4">
        <ThemeSelector />
      </div>

      <main className="relative flex flex-grow flex-col items-center justify-center">
        {/* max-w-full: a column cannot shrink the 370 px card, so this keeps the
            whole form on screen at 320 px and at 400 % zoom (no sideways scroll). */}
        <div className="kade-auth-card relative w-authPageWidth max-w-full overflow-hidden bg-white px-6 py-4 dark:bg-gray-900 sm:max-w-md sm:rounded-lg">
          {!hasStartupConfigError && !isFetching && header && (
            <h1
              className="mb-4 text-center text-3xl font-semibold text-black dark:text-white"
              style={{ userSelect: 'none' }}
            >
              {header}
            </h1>
          )}
          {children}
          {!pathname.includes('2fa') &&
            (pathname.includes('login') || pathname.includes('register')) && (
              <SocialLoginRender startupConfig={startupConfig} />
            )}
        </div>
        {/* The painting comes after the card in reading order (Kade: real alt
            text, no extra block), so the email box is always met first. CSS
            alone shows it behind the card on computers and as the band above
            the card on phones. */}
        {showHouse && <HouseAtDuskPicture />}
      </main>
      <Footer startupConfig={startupConfig} />
    </div>
  );
}

export default AuthLayout;
