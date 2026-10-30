import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, screen, fireEvent } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import { useForm, FormProvider, useWatch } from 'react-hook-form';
import type { AgentForm } from '~/common';
import AgentConfig from '../AgentConfig';

/* Oct 30 2026: the builder's speed control, with everything around it stubbed. */

jest.mock('~/Providers', () => ({
  useFileMapContext: () => ({}),
  useAgentPanelContext: () => ({
    actions: [],
    setAction: () => {},
    regularTools: [],
    agentsConfig: { capabilities: [] },
    availableMCPServers: [],
    mcpServersMap: new Map(),
    setActivePanel: () => {},
    endpointsConfig: {},
  }),
}));

jest.mock('~/hooks', () => {
  const en = jest.requireActual('~/locales/en/translation.json');
  return {
    useLocalize: () => (key: string, values?: Record<string, string>) =>
      Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replace(`{{${name}}}`, value),
        en[key] ?? key,
      ),
    useVisibleTools: () => ({ toolIds: [], mcpServerNames: [] }),
    useHasAccess: () => false,
  };
});

jest.mock('~/hooks/Agents/useAgentCapabilities', () => ({
  __esModule: true,
  default: () => ({}),
}));

jest.mock('~/data-provider', () => ({
  useListSkillsQuery: () => ({ data: undefined }),
  useGetAgentFiles: () => ({ data: [] }),
}));

jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQueries: () => [],
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: () => {} }),
}));

jest.mock('~/components/Audio/Voices', () => ({
  VoicePreviewButton: ({
    speakingRate,
    characterSpeedOnly,
  }: {
    speakingRate?: number;
    characterSpeedOnly?: boolean;
  }) => (
    <button
      type="button"
      data-speaking-rate={String(speakingRate)}
      data-character-speed-only={String(characterSpeedOnly)}
    >
      Preview
    </button>
  ),
  VoiceFlagButton: () => null,
}));

jest.mock('../AgentVoicePicker', () => ({
  __esModule: true,
  default: ({
    speakingRate,
    onChange,
  }: {
    speakingRate?: number;
    onChange: (voice?: string) => void;
  }) => (
    <div data-testid="voice-picker" data-speaking-rate={String(speakingRate)}>
      {/* What the real picker's "No character voice" option calls. */}
      <button type="button" onClick={() => onChange(undefined)}>
        No character voice
      </button>
    </div>
  ),
  extractAgentLines: () => [],
}));

jest.mock('~/components/Tools', () => ({
  ToolSelectDialog: () => null,
  MCPToolSelectDialog: () => null,
}));
jest.mock('~/components/Skills/dialogs', () => ({ SkillSelectDialog: () => null }));
jest.mock('../AgentCategorySelector', () => ({ __esModule: true, default: () => null }));
jest.mock('~/components/SidePanel/Builder/Action', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../Instructions', () => ({ __esModule: true, default: () => null }));
jest.mock('../AgentAvatar', () => ({ __esModule: true, default: () => null }));
jest.mock('../AgentBody', () => ({ __esModule: true, default: () => null }));
jest.mock('../FileContext', () => ({ __esModule: true, default: () => null }));
jest.mock('../Search/Form', () => ({ __esModule: true, default: () => null }));
jest.mock('../FileSearch', () => ({ __esModule: true, default: () => null }));
jest.mock('../Artifacts', () => ({ __esModule: true, default: () => null }));
jest.mock('../AgentTool', () => ({ __esModule: true, default: () => null }));
jest.mock('../Code/Form', () => ({ __esModule: true, default: () => null }));
jest.mock('../MCPTools', () => ({ __esModule: true, default: () => null }));

function Harness({ tts }: { tts?: AgentForm['tts'] }) {
  const methods = useForm<AgentForm>({
    defaultValues: { tts, agent: '', id: 'agent_1' } as unknown as Partial<AgentForm>,
  });
  const saved = useWatch({ control: methods.control, name: 'tts.speakingRate' });
  const savedVoice = useWatch({ control: methods.control, name: 'tts.voiceId' });
  return (
    <FormProvider {...methods}>
      <output data-testid="form-rate">{saved === undefined ? 'undefined' : String(saved)}</output>
      <output data-testid="form-voice">{String(savedVoice)}</output>
      <AgentConfig />
    </FormProvider>
  );
}

const renderBuilder = (tts?: AgentForm['tts']) =>
  render(
    <RecoilRoot>
      <Harness tts={tts} />
    </RecoilRoot>,
  );

describe('builder voice speed', () => {
  it('"No character voice" holds null, which a save can carry, and keeps the speed', () => {
    renderBuilder({ voiceId: 'Voice 1', speakingRate: 1.2 });
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'No character voice' }));
    expect(screen.getByTestId('form-voice')).toHaveTextContent('null');
    expect(screen.getByTestId('form-rate')).toHaveTextContent('1.2');
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
  });

  it('a label that points at a real control, with the numbers and its help', () => {
    renderBuilder({ voiceId: 'Voice 1', speakingRate: 1.2 });
    const select = screen.getByLabelText('Voice speed') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveValue('1.2');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'Default (1x)',
      '0.75x',
      '0.8x',
      '0.9x',
      '1x',
      '1.1x',
      '1.2x',
      '1.3x',
      '1.4x',
      '1.5x',
    ]);
    expect(select).toHaveAccessibleDescription(expect.stringContaining('The default is 1x'));
    expect(screen.getByRole('option', { name: '1.2 times' })).toHaveTextContent('1.2x');
  });

  it('sits directly before Preview, so changing it and hearing it are neighbours', () => {
    renderBuilder({ voiceId: 'Voice 1', speakingRate: 1.2 });
    const focusable = Array.from(document.querySelectorAll<HTMLElement>('select, button')).filter(
      (el) => el.id === 'agent-rate-dropdown' || el.textContent === 'Preview',
    );
    expect(focusable.map((el) => el.tagName)).toEqual(['SELECT', 'BUTTON']);
    const all = Array.from(document.querySelectorAll<HTMLElement>('select, button, input'));
    const at = all.findIndex((el) => el.id === 'agent-rate-dropdown');
    expect(all[at + 1]).toHaveTextContent('Preview');
    expect(screen.getByTestId('voice-picker').compareDocumentPosition(all[at])).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("Preview and the picker follow the character's number as it changes", () => {
    renderBuilder({ voiceId: 'Voice 1', speakingRate: 1.2 });
    const preview = screen.getByRole('button', { name: 'Preview' });
    expect(preview).toHaveAttribute('data-speaking-rate', '1.2');
    expect(preview).toHaveAttribute('data-character-speed-only', 'true');
    fireEvent.change(screen.getByLabelText('Voice speed'), { target: { value: '1.4' } });
    expect(preview).toHaveAttribute('data-speaking-rate', '1.4');
    expect(screen.getByTestId('voice-picker')).toHaveAttribute('data-speaking-rate', '1.4');
  });

  it('a new character says 1x, and has no Preview until it has a voice', () => {
    renderBuilder();
    const select = screen.getByLabelText('Voice speed') as HTMLSelectElement;
    expect(select).toHaveValue('');
    expect(select.selectedOptions[0]).toHaveTextContent('Default (1x)');
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
  });

  it('choosing the default writes null, so the save clears a saved speed', () => {
    renderBuilder({ voiceId: 'Voice 1', speakingRate: 1.2 });
    expect(screen.getByTestId('form-rate')).toHaveTextContent('1.2');
    fireEvent.change(screen.getByLabelText('Voice speed'), { target: { value: '' } });
    expect(screen.getByTestId('form-rate')).toHaveTextContent('null');
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute(
      'data-speaking-rate',
      'undefined',
    );
  });

  it('a saved number off the list shows as itself and stays in the form', () => {
    renderBuilder({ voiceId: 'Voice 1', speakingRate: 1.25 });
    const select = screen.getByLabelText('Voice speed') as HTMLSelectElement;
    expect(select).toHaveValue('1.25');
    expect(select.selectedOptions[0]).toHaveTextContent('1.25x');
    expect(screen.getByTestId('form-rate')).toHaveTextContent('1.25');
  });
});
