import './polyfills/regeneratorRuntime';
import { createRoot } from 'react-dom/client';
import { initializeI18n } from './locales/i18n';
import App from './App';
import '@librechat/client/style.css';
import './style.css';
import './mobile.css';
import { ApiErrorBoundaryProvider } from './hooks/ApiErrorBoundaryContext';
import 'katex/dist/katex.min.css';
import 'katex/dist/contrib/copy-tex.js';
import { migrateVoiceNumbering } from './utils/voiceRenumber2026';
import { applyKadeA11yPrefs } from './utils/kadeA11yPrefs';
import { initKadeLocationShare } from './utils/kadeLocationShare';

// KADE: rewrite saved voice labels for the 2026-07-01 catalog renumbering.
// Must run before React mounts (Recoil's localStorage effects read `voice`
// at atom initialization). One-time, flag-guarded, fail-silent.
migrateVoiceNumbering();

// KADE July 23 2026: resume the opt-in location watch if the setting was on.
// Fail-soft inside; no-op (and no permission prompt) when the toggle is off.
initKadeLocationShare();

// KADE: apply saved low-vision display prefs (contrast/font/spacing) before
// first paint so there is no flash of default styling. Fail-soft inside.
applyKadeA11yPrefs();

window.addEventListener('vite:preloadError', (event) => {
  if (window.__lcRecoverStaleAssets?.()) {
    event.preventDefault();
  }
});

const container = document.getElementById('root');
const root = createRoot(container);

async function bootstrap() {
  await initializeI18n();

  root.render(
    <ApiErrorBoundaryProvider>
      <App />
    </ApiErrorBoundaryProvider>,
  );
}

bootstrap().catch((error) => {
  console.error('[i18n] Failed to initialize before render', error);
  root.render(
    <ApiErrorBoundaryProvider>
      <App />
    </ApiErrorBoundaryProvider>,
  );
});
