import axios from 'axios';
import { librarianGuide } from './guide';
import { ResearchError } from './requests';
import type {
  NoticeReceipt,
  RequestDependencies,
  RequestNotice,
  ResearchDepth,
  ResearchReport,
} from './requests';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const base = (): string =>
  (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');

export interface NoticeChannels {
  /** The phone app's push, through the bridge. */
  phone: (notice: RequestNotice) => Promise<{ sent: number; deferred: boolean }>;
  /** Browser push for anyone who turned it on. Returns how many browsers took it. */
  browser: (notice: RequestNotice) => Promise<number>;
  /** News for the requester's next conversation; replaces any line still waiting for them. */
  chat: (owner: string, text: string) => Promise<void>;
}

/** Sends one grouped alert on every channel and reports honestly what reached the person. */
export function createRequestNotifier(channels: NoticeChannels): RequestDependencies['notify'] {
  return async (notice: RequestNotice): Promise<NoticeReceipt> => {
    const [phone, browser, chat] = await Promise.allSettled([
      channels.phone(notice),
      channels.browser(notice),
      notice.chat ? channels.chat(notice.owner, notice.chat) : Promise.resolve(),
    ]);
    const phoneResult = phone.status === 'fulfilled' ? phone.value : null;
    const browsers = browser.status === 'fulfilled' ? Math.max(0, browser.value) : 0;
    const chatQueued = !!notice.chat && chat.status === 'fulfilled';
    const note = chatQueued ? 'Their next conversation will also mention it.' : '';
    if ((phoneResult?.sent || 0) + browsers > 0) return { state: 'sent', note };
    if (phoneResult?.deferred) return { state: 'deferred', note };
    if (phone.status === 'rejected' && browser.status === 'rejected' && !chatQueued)
      return { state: 'unconfirmed' };
    return { state: 'saved', note };
  };
}

/** A requested push (the person asked for this news): quiet hours defer it instead of dropping it. */
export async function libraryRequestPhoneAlert(
  notice: RequestNotice,
): Promise<{ sent: number; deferred: boolean }> {
  const secret = process.env.BRIDGE_SECRET;
  if (!secret) return { sent: 0, deferred: false };
  const response = await axios.post<{ sent?: number; deferred?: boolean }>(
    `${base()}/notify`,
    {
      userId: notice.owner,
      agentId: 'library-requests',
      agentName: 'The Library',
      title: notice.title,
      body: notice.body,
      requested: true,
      urgent: false,
      route: 'library',
    },
    { headers: { 'x-bridge-secret': secret, 'User-Agent': UA }, timeout: 20000 },
  );
  return {
    sent: Number(response.data?.sent) || 0,
    deferred: response.data?.deferred === true,
  };
}

/* The research desk accepts the scoped agent secret, as kade_research uses, or the admin secret. */
function researchHeaders(): Record<string, string> | null {
  if (process.env.NOTIFY_AGENT_SECRET)
    return { 'x-notify-secret': process.env.NOTIFY_AGENT_SECRET, 'User-Agent': UA };
  if (process.env.BRIDGE_SECRET)
    return { 'x-bridge-secret': process.env.BRIDGE_SECRET, 'User-Agent': UA };
  return null;
}
const refusal = (error: unknown): string => {
  if (!axios.isAxiosError(error) || !error.response) return '';
  const data: unknown = error.response.data;
  const message =
    data && typeof data === 'object' && 'error' in data
      ? String((data as { error: unknown }).error)
      : '';
  return message.replace(/\s+/g, ' ').slice(0, 160);
};

export const libraryResearchTransport: Pick<
  RequestDependencies,
  'startResearch' | 'researchStatus'
> = {
  async startResearch(
    by: string,
    question: string,
    focus: string,
    depth: ResearchDepth,
  ): Promise<{ id: string; note: string }> {
    const headers = researchHeaders();
    if (!headers) throw new ResearchError('research is not set up on this server');
    let data: { id?: string; etaMinutes?: number; position?: number };
    try {
      const response = await axios.post<{ id?: string; etaMinutes?: number; position?: number }>(
        `${base()}/research/start`,
        {
          userId: by,
          agentId: librarianGuide.agentId,
          agentName: librarianGuide.name,
          question,
          focus,
          depth,
          include_personal_notes: false,
        },
        { headers, timeout: 20000 },
      );
      data = response.data || {};
    } catch (error) {
      const why = refusal(error);
      // An answer that refused means nothing started; no answer at all might mean it did.
      if (axios.isAxiosError(error) && error.response)
        throw new ResearchError(why || 'the research desk refused it');
      throw new ResearchError('the research desk did not answer', true);
    }
    if (!data.id) throw new ResearchError('the research desk did not return a run', true);
    const minutes = data.etaMinutes || 5;
    return {
      id: data.id,
      note:
        'Started. About ' +
        minutes +
        ' minutes' +
        (data.position ? ', with ' + data.position + ' ahead of it' : '') +
        '.',
    };
  },
  async researchStatus(by: string, id: string): Promise<ResearchReport> {
    const headers = researchHeaders();
    if (!headers) throw new ResearchError('research is not set up on this server');
    const params = { userId: by, id };
    const status = await axios.get<{
      status?: string;
      stageNote?: string;
      error?: string;
      costs?: { estUSD?: number };
    }>(`${base()}/research/status`, {
      params,
      headers,
      timeout: 15000,
      validateStatus: (code) => code < 500,
    });
    if (status.status === 404)
      return { state: 'missing', note: 'The research desk no longer has this run.' };
    if (status.status >= 400)
      throw new ResearchError(String(status.data?.error || 'the research desk refused it'));
    const state = String(status.data?.status || 'unknown');
    const note = String(status.data?.stageNote || status.data?.error || '').slice(0, 500);
    const costUsd =
      typeof status.data?.costs?.estUSD === 'number' ? status.data.costs.estUSD : undefined;
    if (state !== 'done') return { state, note, costUsd };
    const report = await axios.get<{
      report?: string;
      sourceList?: { title?: string; url?: string }[];
    }>(`${base()}/research/report`, { params, headers, timeout: 20000 });
    return {
      state,
      note,
      costUsd,
      report: String(report.data?.report || '').slice(0, 8000),
      sources: (report.data?.sourceList || []).slice(0, 20).map((source) => ({
        title: String(source.title || source.url || '').slice(0, 200),
        url: String(source.url || '').slice(0, 500),
      })),
    };
  },
};
