import type * as t from './types';
import { EndpointURLs } from './config';
import * as s from './schemas';

/** Resolves the browser's IANA timezone so the server can localize prompt variables. */
function getUserTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** KADE July 23 2026: opt-in location ride-along. The client's geolocation
 * watcher (utils/kadeLocationShare.ts) keeps window.__kadeUserLocation fresh
 * ONLY while the "Share my location" setting is on; here we attach it when
 * it's present and recent (10 min). The server-side kade_location tool reads
 * it off the request body. Setting off / stale / non-browser = undefined =
 * nothing attached, exactly the old payload. */
function getUserLocation():
  | { lat: number; lon: number; accuracy?: number; at: string }
  | undefined {
  try {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const loc = (window as { __kadeUserLocation?: { lat: number; lon: number; accuracy?: number; at: string } })
      .__kadeUserLocation;
    if (!loc || typeof loc.lat !== 'number' || typeof loc.lon !== 'number') {
      return undefined;
    }
    if (Date.now() - new Date(loc.at).getTime() > 10 * 60 * 1000) {
      return undefined;
    }
    return loc;
  } catch {
    return undefined;
  }
}

export default function createPayload(submission: t.TSubmission) {
  const {
    isEdited,
    addedConvo,
    userMessage,
    isContinued,
    isTemporary,
    isRegenerate,
    conversation,
    editedContent,
    ephemeralAgent,
    endpointOption,
    manualSkills,
  } = submission;
  const { conversationId } = s.tConvoUpdateSchema.parse(conversation);
  const { endpoint: _e, endpointType } = endpointOption as {
    endpoint: s.EModelEndpoint;
    endpointType?: s.EModelEndpoint;
  };

  const endpoint = _e as s.EModelEndpoint;
  let server = `${EndpointURLs[s.EModelEndpoint.agents]}/${endpoint}`;
  if (s.isAssistantsEndpoint(endpoint)) {
    server =
      EndpointURLs[(endpointType ?? endpoint) as 'assistants' | 'azureAssistants'] +
      (isEdited ? '/modify' : '');
  }

  const payload: t.TPayload = {
    ...userMessage,
    ...endpointOption,
    endpoint,
    addedConvo,
    isTemporary,
    isRegenerate,
    editedContent,
    conversationId,
    isContinued: !!(isEdited && isContinued),
    ephemeralAgent: s.isAssistantsEndpoint(endpoint) ? undefined : ephemeralAgent,
    manualSkills: s.isAssistantsEndpoint(endpoint) ? undefined : manualSkills,
    timezone: getUserTimezone(),
    userLocation: getUserLocation(),
  };

  return { server, payload };
}
