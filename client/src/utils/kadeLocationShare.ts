/**
 * KADE July 23 2026 — opt-in location ride-along (MAPS_GPS_WORKUP slice 1).
 *
 * When the Settings toggle ("Share my location with your companions") is ON,
 * a foreground geolocation watch keeps `window.__kadeUserLocation` fresh:
 * `{lat, lon, accuracy, at}`. createPayload attaches it to chat requests as
 * `userLocation`, and the server-side kade_location tool answers "where am
 * I / what's around / walk me there" from it. OFF (the default) = no watch,
 * no global, nothing ever attached — the tool then tells the user about the
 * setting instead of guessing.
 *
 * Foreground-only by design (web code gets no background GPS), fail-soft
 * everywhere: no geolocation API, permission denied, or any error simply
 * means no location rides along.
 */

const STORAGE_KEY = 'kadeShareLocation';

declare global {
  interface Window {
    __kadeUserLocation?: { lat: number; lon: number; accuracy?: number; at: string };
  }
}

let watchId: number | null = null;

export function locationSharingEnabled(): boolean {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'false') === true;
  } catch {
    return false;
  }
}

export function startLocationShare(): void {
  try {
    if (watchId != null || typeof navigator === 'undefined' || !navigator.geolocation) {
      return;
    }
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        window.__kadeUserLocation = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? undefined,
          at: new Date().toISOString(),
        };
      },
      () => {
        // Denied/unavailable: leave no stale fix behind.
        delete window.__kadeUserLocation;
      },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 },
    );
  } catch {
    // fail-soft: location must never break the app
  }
}

export function stopLocationShare(): void {
  try {
    if (watchId != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
    }
  } catch {
    // ignore
  }
  watchId = null;
  try {
    delete window.__kadeUserLocation;
  } catch {
    // ignore
  }
}

/** Boot hook (main.jsx): resume the watch when the setting was left on. */
export function initKadeLocationShare(): void {
  if (locationSharingEnabled()) {
    startLocationShare();
  }
}
