import { speedLabel, speedOptions, speedSpoken } from '~/utils/voicePace';

/** Oct 30 2026: the one voice speed control, shared by Settings, the chat header and the character
 * builder. A native select, so a screen reader gets a real list. Each option shows "1.2x" and is
 * named "1.2 times"; 1x is named "Normal". The empty option is the caller's: it says what no choice
 * plays at. A saved number off the list shows as itself and stays what is sent until the person
 * changes it. */
export default function VoiceSpeedSelect({
  id,
  value,
  onChange,
  emptyText,
  emptySpoken,
  disabled,
  describedBy,
}: {
  id: string;
  value?: number | null;
  onChange: (speed: number | null) => void;
  emptyText: string;
  emptySpoken: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <select
      id={id}
      className="w-full rounded border border-border-medium bg-surface-secondary p-2"
      disabled={disabled}
      aria-describedby={describedBy}
      value={value == null ? '' : String(value)}
      onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
    >
      <option value="" aria-label={emptySpoken}>
        {emptyText}
      </option>
      {speedOptions(value).map((speed) => (
        <option key={speed} value={speed} aria-label={speedSpoken(speed)}>
          {speedLabel(speed)}
        </option>
      ))}
    </select>
  );
}
