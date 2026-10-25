import { findAllArtifacts, replaceArtifactContent } from './update';

const artifactText = [
  ':::artifact{identifier="example" type="text/markdown" title="Example"}',
  '```md',
  'ORIGINAL',
  '```',
  ':::',
].join('\n');

const artifact = {
  start: 0,
  end: artifactText.length,
  source: 'text' as const,
  text: artifactText,
};

/** Jest cannot interrupt synchronous work, so a timeout alone never fails a slow regex. */
const timed = <T>(fn: () => T): { result: T; ms: number } => {
  const started = performance.now();
  const result = fn();
  return { result, ms: performance.now() - started };
};

describe('replaceArtifactContent', () => {
  it('replaces the matched content inside the artifact', () => {
    const result = replaceArtifactContent(artifactText, artifact, 'ORIGINAL', 'UPDATED');

    expect(result).toBe(artifactText.replace('ORIGINAL', 'UPDATED'));
  });

  it('collapses blank lines before the closing code and artifact fence', () => {
    const result = replaceArtifactContent(artifactText, artifact, 'ORIGINAL', 'UPDATED\n\n\n');

    expect(result).toContain('UPDATED\n```\n:::');
    expect(result).not.toContain('UPDATED\n\n');
  });

  it('keeps blank lines that are not right before the closing fence', () => {
    const result = replaceArtifactContent(artifactText, artifact, 'ORIGINAL', 'one\n\n\ntwo');

    expect(result).toContain('one\n\n\ntwo\n```\n:::');
  });

  it('handles long whitespace near-misses without backtracking', () => {
    const updated = `\n\`\`\`${' \n'.repeat(100_000)}X`;
    const { result, ms } = timed(() =>
      replaceArtifactContent(artifactText, artifact, 'ORIGINAL', updated),
    );

    expect(result).toContain(updated);
    expect(ms).toBeLessThan(1_000);
  });

  it('handles long consecutive-newline near-misses without backtracking', () => {
    const updated = `\n\`\`\`${'\n'.repeat(100_000)}X`;
    const { result, ms } = timed(() =>
      replaceArtifactContent(artifactText, artifact, 'ORIGINAL', updated),
    );

    expect(result).toContain(updated);
    expect(ms).toBeLessThan(1_000);
  });

  it('finds every artifact whose code fence never closes without rescanning the text', () => {
    const text = ':::artifact\n```x\n:::\n'.repeat(8_000);
    const { result, ms } = timed(() => findAllArtifacts({ text }));

    expect(result).toHaveLength(8_000);
    expect(result[1].start).toBe(':::artifact\n```x\n:::\n'.length);
    expect(ms).toBeLessThan(1_000);
  });

  it('collapses a near-limit newline run in linear time', () => {
    const updated = `UPDATED${'\n'.repeat(2_500_000)}`;
    const { result, ms } = timed(() =>
      replaceArtifactContent(artifactText, artifact, 'ORIGINAL', updated),
    );

    expect(result).toContain('UPDATED\n```\n:::');
    expect(ms).toBeLessThan(1_000);
  });
});
