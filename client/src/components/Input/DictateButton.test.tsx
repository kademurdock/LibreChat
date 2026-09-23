import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DictateButton from './DictateButton';

const mockTranscribe = jest.fn();
jest.mock('~/data-provider', () => ({
  useSpeechToTextMutation: () => ({ mutateAsync: mockTranscribe }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

class Recorder {
  static isTypeSupported = () => true;
  static latest: Recorder;
  state = 'inactive';
  mimeType = 'audio/webm';
  onstop: (() => void) | null = null;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public stream: MediaStream) {
    Recorder.latest = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['audio']) });
    this.onstop?.();
  }
}
const stopTrack = jest.fn();
const stream = { getTracks: () => [{ stop: stopTrack }] };
const getUserMedia = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(global, 'MediaRecorder', { configurable: true, value: Recorder });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  getUserMedia.mockResolvedValue(stream);
});

it('releases the microphone before transcription and appends once through the latest callback', async () => {
  let resolve!: (value: { text: string }) => void;
  mockTranscribe.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const oldAppend = jest.fn();
  const append = jest.fn();
  const { rerender } = render(<DictateButton onTranscript={oldAppend} />);
  fireEvent.click(screen.getByRole('button'));
  await screen.findByText('com_ui_dictation_stop');
  fireEvent.click(screen.getByRole('button'));
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(oldAppend).not.toHaveBeenCalled();
  rerender(<DictateButton onTranscript={append} />);
  await act(async () => resolve({ text: '  new words  ' }));
  expect(append).toHaveBeenCalledWith('new words');
  expect(append).toHaveBeenCalledTimes(1);
  expect(oldAppend).not.toHaveBeenCalled();
});

it('ignores a late transcript when its editor is closed', async () => {
  let resolve!: (value: { text: string }) => void;
  mockTranscribe.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const append = jest.fn();
  const { rerender } = render(<DictateButton onTranscript={append} />);
  fireEvent.click(screen.getByRole('button'));
  await screen.findByText('com_ui_dictation_stop');
  fireEvent.click(screen.getByRole('button'));
  rerender(<DictateButton onTranscript={append} active={false} />);
  await act(async () => resolve({ text: 'late words' }));
  expect(append).not.toHaveBeenCalled();
});

it('releases a microphone granted after unmount without sending audio', async () => {
  let resolve!: (value: unknown) => void;
  getUserMedia.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const { unmount } = render(<DictateButton onTranscript={jest.fn()} />);
  fireEvent.click(screen.getByRole('button'));
  unmount();
  await act(async () => resolve(stream));
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(mockTranscribe).not.toHaveBeenCalled();
});

it('preserves the draft and permits retry after transcription fails', async () => {
  mockTranscribe.mockRejectedValue(new Error('offline'));
  const append = jest.fn();
  render(<DictateButton onTranscript={append} />);
  fireEvent.click(screen.getByRole('button'));
  await screen.findByText('com_ui_dictation_stop');
  fireEvent.click(screen.getByRole('button'));
  await screen.findByText('com_ui_dictation_error');
  expect(append).not.toHaveBeenCalled();
  await waitFor(() => expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false));
});
