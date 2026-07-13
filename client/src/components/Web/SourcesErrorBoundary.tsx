import React, { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  showDetails?: boolean;
  /* KADE July 13 2026: change this to auto-clear a transient error and re-try
   * rendering the children (e.g. when the message re-renders during a
   * share/read-aloud). Prevents the error UI from sticking + looping. */
  resetKey?: unknown;
}

interface State {
  hasError: boolean;
}

class SourcesErrorBoundary extends Component<Props, State> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Sources error:', error);
    this.props.onError?.(error, errorInfo);
  }

  componentDidUpdate(prevProps: Props) {
    // A transient error (thrown during a share/re-render on a news convo) must
    // NOT stick and trap VoiceOver. When the resetKey changes, drop hasError so
    // the children get one clean re-render.
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      // Use custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      /* KADE July 13 2026: QUIET fallback — NOT a live region (was role="alert"
       * aria-live="polite", which re-announced "Refresh" on every re-render and
       * trapped VoiceOver in a refresh-refresh-refresh loop), and NO
       * window.location.reload() button (it nuked the whole app). Sources are
       * supplementary; if they can't render, show a small static note and let
       * the resetKey auto-recover them on the next good render. */
      /* eslint-disable i18next/no-literal-string */
      return (
        <div className="rounded-lg border border-border-medium bg-surface-secondary p-3 text-center text-xs text-text-tertiary">
          Sources couldn't load.
        </div>
      );
      /* eslint-enable i18next/no-literal-string */
    }

    return this.props.children;
  }
}

export default SourcesErrorBoundary;
