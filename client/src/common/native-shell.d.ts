interface Window {
  Capacitor?: {
    isNativePlatform?: () => boolean;
    Plugins?: { KadeScanText?: { start: () => Promise<void>; stop: () => Promise<void> } };
  };
}
