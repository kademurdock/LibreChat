import { resolveTimezone, HOUSE_TIMEZONE } from '../timeAnchor';

/* Part 99.2 — the fix for a prompt that carried two clocks. The red proof this
 * suite is built around: an absent timezone used to mean UTC, five hours off
 * her wall clock and a DIFFERENT DAY after 7 PM Central. */
describe('resolveTimezone', () => {
  const OLD = process.env.LC_DEFAULT_TIMEZONE;
  beforeEach(() => {
    delete process.env.LC_DEFAULT_TIMEZONE;
  });
  afterEach(() => {
    if (OLD === undefined) {
      delete process.env.LC_DEFAULT_TIMEZONE;
    } else {
      process.env.LC_DEFAULT_TIMEZONE = OLD;
    }
  });

  it('THE BUG: a lane that sends no timezone gets Central, not UTC', () => {
    expect(resolveTimezone(undefined)).toBe('America/Chicago');
    expect(resolveTimezone(undefined)).toBe(HOUSE_TIMEZONE);
  });

  it('empty and whitespace-only count as "sent nothing"', () => {
    expect(resolveTimezone('')).toBe(HOUSE_TIMEZONE);
    expect(resolveTimezone('   ')).toBe(HOUSE_TIMEZONE);
  });

  it('A REAL BROWSER TIMEZONE STILL WINS — travelling family keep their own clock', () => {
    expect(resolveTimezone('America/New_York')).toBe('America/New_York');
    expect(resolveTimezone('Europe/London')).toBe('Europe/London');
    expect(resolveTimezone('America/Chicago')).toBe('America/Chicago');
  });

  it('trims a padded zone rather than discarding it', () => {
    expect(resolveTimezone('  America/Denver  ')).toBe('America/Denver');
  });

  it('LC_DEFAULT_TIMEZONE overrides the house default', () => {
    process.env.LC_DEFAULT_TIMEZONE = 'America/Denver';
    expect(resolveTimezone(undefined)).toBe('America/Denver');
    expect(resolveTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
  });

  it('LC_DEFAULT_TIMEZONE="" is the instant revert to the old UTC fallback', () => {
    process.env.LC_DEFAULT_TIMEZONE = '';
    expect(resolveTimezone(undefined)).toBeUndefined();
  });

  it('a whitespace-only override is treated as unset, not as a revert', () => {
    process.env.LC_DEFAULT_TIMEZONE = '   ';
    expect(resolveTimezone(undefined)).toBe(HOUSE_TIMEZONE);
  });
});
