export interface ReverieExit {
  dir: string;
  label: string;
  to: string;
  toId: string;
  locked: boolean;
  missing?: boolean;
  returning?: boolean;
}

interface OrientationRoom {
  name: string;
  peopleDetail?: { line: string }[];
  exitsDetail: ReverieExit[];
}

function exitStatus(exit: ReverieExit): string {
  if (exit.missing) return ' (unavailable)';
  return exit.locked ? ' (locked)' : '';
}

/** Only the viewer's current room projection enters this description. */
export function reverieOrientation(room: OrientationRoom): string[] {
  const people = room.peopleDetail || [];
  const exits = room.exitsDetail;
  const back = exits.find((exit) => exit.returning);
  return [
    `You are at ${room.name}.`,
    people.length
      ? `Here with you: ${people.map((person) => person.line).join('; ')}.`
      : 'Nobody else is here.',
    exits.length
      ? `Ways out: ${exits.map((exit) => `${exit.label} to ${exit.to}${exitStatus(exit)}`).join('; ')}.`
      : 'There are no exits here.',
    ...(back
      ? [
          `Your last room is ${back.to}, ${back.label}${back.locked ? '; the way is now locked' : ''}.`,
        ]
      : []),
  ];
}

interface WhisperPerson {
  userId: string;
  name: string;
}
type WhisperTarget =
  | { ok: true; person: WhisperPerson; words: string }
  | { ok: false; line: string };

export function resolveReverieWhisper(text: string, people: WhisperPerson[]): WhisperTarget {
  const quoted = /^("(?:\\.|[^"\\])*")\s+([\s\S]+)$/.exec(text.trim());
  let matches: WhisperPerson[];
  let words: string;
  if (quoted) {
    let name: string;
    try {
      name = JSON.parse(quoted[1]) as string;
    } catch {
      return { ok: false, line: 'Use whisper "Full Name" followed by your words.' };
    }
    matches = people.filter((person) => person.name.toLowerCase() === name.toLowerCase());
    words = quoted[2].trim();
  } else {
    const input = text.trim();
    const lower = input.toLowerCase();
    matches = people.filter((person) => lower.startsWith(person.name.toLowerCase() + ' '));
    const longest = Math.max(0, ...matches.map((person) => person.name.length));
    matches = matches.filter((person) => person.name.length === longest);
    const first = input.split(/\s+/)[0];
    if (!matches.length)
      matches = people.filter(
        (person) => person.name.split(/\s+/)[0].toLowerCase() === first.toLowerCase(),
      );
    words = input.slice(longest || first.length).trim();
  }
  if (!words) return { ok: false, line: 'Use whisper "Full Name" followed by your words.' };
  if (!matches.length)
    return { ok: false, line: 'That person is not here to whisper to. Check Here with you.' };
  if (matches.length > 1)
    return {
      ok: false,
      line: 'That name matches more than one person here. Use a unique full name in quotes.',
    };
  return { ok: true, person: matches[0], words };
}
