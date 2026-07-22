import { quantizeTimeAnchor } from '../timeAnchor';

describe('quantizeTimeAnchor', () => {
  const OLD_ENV = process.env.LC_TIME_ANCHOR_QUANTUM_MIN;
  afterEach(() => {
    if (OLD_ENV === undefined) {
      delete process.env.LC_TIME_ANCHOR_QUANTUM_MIN;
    } else {
      process.env.LC_TIME_ANCHOR_QUANTUM_MIN = OLD_ENV;
    }
  });

  it('floors to the hour by default', () => {
    delete process.env.LC_TIME_ANCHOR_QUANTUM_MIN;
    expect(quantizeTimeAnchor('2026-07-22T13:45:12.123Z')?.toISOString()).toBe(
      '2026-07-22T13:00:00.000Z',
    );
  });

  it('is stable across the whole window (the point of the fix)', () => {
    delete process.env.LC_TIME_ANCHOR_QUANTUM_MIN;
    const a = quantizeTimeAnchor('2026-07-22T13:00:00.000Z')?.getTime();
    const b = quantizeTimeAnchor('2026-07-22T13:59:59.999Z')?.getTime();
    expect(a).toBe(b);
  });

  it('LC_TIME_ANCHOR_QUANTUM_MIN=0 restores exact behavior', () => {
    process.env.LC_TIME_ANCHOR_QUANTUM_MIN = '0';
    expect(quantizeTimeAnchor('2026-07-22T13:45:12.123Z')?.toISOString()).toBe(
      '2026-07-22T13:45:12.123Z',
    );
  });

  it('honors a custom quantum', () => {
    process.env.LC_TIME_ANCHOR_QUANTUM_MIN = '15';
    expect(quantizeTimeAnchor('2026-07-22T13:44:59.000Z')?.toISOString()).toBe(
      '2026-07-22T13:30:00.000Z',
    );
  });

  it('returns undefined for unparseable input (falls through to dayjs default)', () => {
    expect(quantizeTimeAnchor('not-a-date')).toBeUndefined();
  });

  it('quantizes wall-clock when no anchor supplied', () => {
    delete process.env.LC_TIME_ANCHOR_QUANTUM_MIN;
    const q = quantizeTimeAnchor();
    expect(q).toBeInstanceOf(Date);
    expect(q!.getMinutes()).toBe(0);
    expect(q!.getSeconds()).toBe(0);
  });
});
