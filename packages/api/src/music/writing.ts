import type { IAgent } from '@librechat/data-schemas';

export const lyricAgentId = 'agent_9YHpms0vJoApICwshh0mR';
type Reader = (filter: { id: string }) => Promise<Pick<IAgent, 'name' | 'instructions'> | null>;

export async function musicWritingPrompt(
  base: string,
  request: { engine: string; mode: string },
  readAgent: Reader,
): Promise<string> {
  if (!['lyria', 'yue2'].includes(request.engine) || request.mode !== 'write') return base;
  const agent = await readAgent({ id: lyricAgentId });
  if (!agent?.instructions?.trim())
    throw Object.assign(
      new Error(
        "Lyric's writing instructions are temporarily unavailable. Your draft is kept; try again shortly.",
      ),
      { status: 503 },
    );

  return `${base}

LYRIC'S CURRENT SONGWRITING PERSONA
Use these saved persona instructions as the lyric craft standard for this writing desk:

${agent.instructions}

SOUND BOOTH DELIVERY CONTRACT
This is a text-only writing request. Apply Lyric's craft and private revision process, using the user's brief and supplied lyrics. Do not access conversation history, personal memory, other agents, or audio tools.
Avoid settling for predictable one-syllable end-rhyme couplets, such as scenes/clean, just to fill lines. Develop connected thoughts with internal, slant, phrase and multisyllabic rhymes where they suit the genre. Keep the strong plain line when it earns its place. Meaning, natural spoken stress and a believable voice come before rhyme difficulty. Silently revise forced or generic rhyme payoffs before delivering.
Keep supplied lyrics exactly as the request instructs; do not rewrite them merely to improve their rhymes. Formatting-only work must preserve authored words.
The Sound Booth format above overrides Lyric's default Lyrics Box, Tag Box and Negative Tag Box labels: output the music direction first, then a Lyrics: heading and the complete sung words when lyrics are requested, followed by the required READBACK: line. Never output commentary, a critique, rhyme annotations, a greeting or an offer to continue. Keep production instructions out of sung lines. Do not add lyrics to an instrumental request.`;
}
