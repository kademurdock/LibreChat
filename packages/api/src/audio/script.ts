export const seedSceneContext = `SEED SCENE CONTEXT
Read the declared characters, species, actions and fictional setting together. Write original comedy, satire and dialogue in the requested form. A youthful or childlike voice is a vocal trait; an explicitly fictional animal with that voice is still that animal. A kitten's stated age is the kitten's age. Develop ordinary pet mischief from the brief as animal comedy, rather than inferring a human child or real harm from vague words such as "bad" alone.
Named shows or performers can guide the requested format, pacing, studio imaging and audience energy. Write original hosts and dialogue; a style reference does not assign a real person's identity or voice to a host and does not ask for copied dialogue.
Preserve explicit @Audio1, @Audio2 and @Audio3 actor assignments. These are supplied reference actors or slots the person explicitly reserves for a later import. Only treat a clip as imported when the request says it is imported. This is text-only writing: do not claim to have listened to a clip, identified its speaker, uploaded voices or made audio.
These clarifications do not override safety requirements or make actual harmful human content acceptable under fictional, animal or clinical labels.`;

export function seedWritingPrompt(base: string, engine: string, mode: string): string {
  if (engine !== 'seed' || mode !== 'write') return base;
  return `${base}\n\n${seedSceneContext}`;
}

export type ScriptWriterReply = {
  text: string;
  refusal?: string | null;
  finishReason?: string | null;
};

export class ScriptWriterRefusal extends Error {
  readonly status = 422;
  readonly code = 'SOUNDBOOTH_WRITER_REFUSED';

  constructor() {
    super(
      'The writing model declined this request instead of returning a script. No audio was generated.',
    );
    this.name = 'ScriptWriterRefusal';
  }
}

const sceneSyntax = /^\s*(?:\[Setting\s*:|(?!READBACK\s*:|TITLE\s*:)[^:\n]{1,160}:\s*["“])/i;
const bareRefusal =
  /^(?:(?:i(?:['’]m| am)\s+)?sorry\b[\s,.:;!-]*(?:but\s+)?|unfortunately[\s,.:;!-]*)?(?:i|we)\s+(?:cannot|can['’]t|am unable to|are unable to|am not able to|are not able to)\s+(?:(?:assist|help)(?:\s+you)?\s+with\s+(?:this|that|your|the)\s+(?:request|content|script|scenario|prompt)\b|(?:fulfill|fulfil|comply with|complete)\s+(?:this|that|your|the)\s+request\b|(?:write|generate|create|provide|produce)\s+(?:(?:this|that|the requested|such|a|an)\s+)?(?:script|scene|scenario|content)\b)/i;

export function assertSeedScriptReply(reply: ScriptWriterReply): void {
  if (reply.refusal?.trim() || reply.finishReason === 'content_filter') {
    throw new ScriptWriterRefusal();
  }
  const text = reply.text
    .trim()
    .replace(/^```[^\n]*\n([\s\S]*?)\n?```$/, '$1')
    .trim();
  if (bareRefusal.test(text) && !sceneSyntax.test(text)) throw new ScriptWriterRefusal();
}
