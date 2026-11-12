// client/src/a11y/Announcer.tsx
import React from 'react';

export type LogEntry = { id: number; text: string };

interface AnnouncerProps {
  statusMessage: string;
  logEntries: LogEntry[];
}

/* Nov 12 2026 (WEB-14): the log holds each announcement as its own line, so one never
 * overwrites another and the same words twice are spoken twice. Lines leave on a timer. */
const Announcer: React.FC<AnnouncerProps> = ({ statusMessage, logEntries }) => {
  return (
    <div className="sr-only">
      <div role="status" aria-live="polite" aria-atomic="true">
        {statusMessage}
      </div>
      <div role="log" aria-live="polite" aria-relevant="additions">
        {logEntries.map((entry) => (
          <p key={entry.id}>{entry.text}</p>
        ))}
      </div>
    </div>
  );
};

export default Announcer;
