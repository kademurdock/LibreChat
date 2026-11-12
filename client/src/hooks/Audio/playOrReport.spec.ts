import { playOrReport } from './speech';

const audioThat = (play: () => Promise<void>) => ({ play }) as unknown as HTMLMediaElement;
const rejects = (name: string) => () => Promise.reject(new DOMException('x', name));

test('a refusal by the autoplay rule is reported as blocked', async () => {
  const onRefused = jest.fn();
  await playOrReport(audioThat(rejects('NotAllowedError')), onRefused);
  expect(onRefused).toHaveBeenCalledWith('blocked');
});

test('an unplayable clip is reported as failed', async () => {
  const onRefused = jest.fn();
  await playOrReport(audioThat(rejects('NotSupportedError')), onRefused);
  expect(onRefused).toHaveBeenCalledWith('failed');
});

test('a pause or new load racing play() is not reported', async () => {
  const onRefused = jest.fn();
  await playOrReport(audioThat(rejects('AbortError')), onRefused);
  await playOrReport(
    audioThat(() => Promise.resolve()),
    onRefused,
  );
  expect(onRefused).not.toHaveBeenCalled();
});
