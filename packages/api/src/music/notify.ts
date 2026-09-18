import axios from 'axios';

type Receipt = {
  ok?: boolean;
  sent?: number;
  deferred?: boolean;
  blocked?: string;
  error?: string;
  note?: string;
};
type Delivery = { at: Date; accepted: number; deferred?: boolean; blocked?: string };

export async function notifyMusic(
  user: string,
  title: string,
  completed: number,
  total: number,
  failed: boolean,
  kind: 'music' | 'effects' = 'music',
): Promise<Delivery> {
  const at = new Date();
  if (!process.env.BRIDGE_SECRET)
    return { at, accepted: 0, blocked: 'Notification service is not configured' };
  const base = (
    process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app'
  ).replace(/\/$/, '');
  let readyTitle = total === 1 ? 'Your song is ready' : 'Your songs are ready';
  if (kind === 'effects') readyTitle = 'Your sounds are ready';
  const response = await axios.post<Receipt>(
    `${base}/notify`,
    {
      userId: user,
      agentId: 'soundbooth',
      agentName: 'Sound Booth',
      title: failed
        ? `Your ${kind === 'effects' ? 'sound' : 'music'} batch has stopped`
        : readyTitle,
      body: `${title}: ${completed} of ${total} takes saved. Open the Sound Booth to listen${total > 1 ? ' and compare' : ''}.${failed ? ' Your writing and finished takes are kept.' : ''}`,
      requested: true,
      urgent: false,
      route: 'sound-booth',
    },
    {
      headers: {
        'x-bridge-secret': process.env.BRIDGE_SECRET,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
      timeout: 20000,
    },
  );
  const result = response.data;
  return {
    at,
    accepted: result.sent || 0,
    deferred: result.deferred === true,
    blocked:
      result.blocked ||
      result.error ||
      result.note ||
      (result.ok ? undefined : 'Notification was not accepted'),
  };
}
