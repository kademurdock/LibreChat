import axios from 'axios';
import type { ILibraryRequest } from '@librechat/data-schemas';
import { librarianGuide } from './guide';
import type { RequestDependencies } from './requests';

const base = () =>
  (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
const headers = () => ({
  'x-notify-secret': process.env.NOTIFY_AGENT_SECRET || process.env.BRIDGE_SECRET || '',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});

export const libraryRequestTransport: Pick<
  RequestDependencies,
  'notify' | 'startResearch' | 'researchStatus'
> = {
  async notify(row: ILibraryRequest): Promise<{ state: string; note?: string }> {
    if (!headers()['x-notify-secret'])
      return {
        state: 'unavailable',
        note: 'Phone notifications are not configured. Your update is saved here.',
      };
    const result = await axios.post<{
      ok?: boolean;
      sent?: number;
      deferred?: boolean;
      blocked?: string;
      error?: string;
    }>(
      `${base()}/notify`,
      {
        userId: row.owner,
        agentId: librarianGuide.agentId,
        agentName: librarianGuide.name,
        title:
          row.status === 'fulfilled'
            ? 'Your library request is ready'
            : 'Your library request has an update',
        body:
          row.title +
          ': ' +
          row.status +
          '. Open Library requests to read the update' +
          (row.status === 'fulfilled' ? ' and open your item.' : '.'),
        requested: true,
        urgent: false,
        route: 'library',
      },
      { headers: headers(), timeout: 20000 },
    );
    if (result.data.deferred)
      return { state: 'deferred', note: 'Phone notification queued for after quiet hours.' };
    if (result.data.sent) return { state: 'sent', note: 'Notification accepted for delivery.' };
    return {
      state: 'unavailable',
      note:
        result.data.blocked ||
        result.data.error ||
        'No phone delivery confirmed. The update is saved here.',
    };
  },
  async startResearch(owner: string, question: string, depth: string) {
    if (!headers()['x-notify-secret']) throw new Error('Research is not configured.');
    const result = await axios.post<{ id: string; etaMinutes?: number }>(
      `${base()}/research/start`,
      {
        userId: owner,
        agentId: librarianGuide.agentId,
        agentName: librarianGuide.name,
        question,
        depth,
        include_personal_notes: false,
      },
      { headers: headers(), timeout: 20000 },
    );
    if (!result.data.id) throw new Error('Research did not return a run ID.');
    return {
      id: result.data.id,
      note:
        'Background research started; roughly ' +
        (result.data.etaMinutes || 5) +
        ' minutes. Ask the librarian for the report when ready.',
    };
  },
  async researchStatus(owner: string, id: string) {
    const result = await axios.get<{ status: string; stageNote?: string; error?: string }>(
      `${base()}/research/status`,
      {
        params: { userId: owner, id },
        headers: headers(),
        timeout: 15000,
      },
    );
    return {
      state: result.data.status,
      note: (result.data.stageNote || result.data.error || '').slice(0, 1000),
    };
  },
};
