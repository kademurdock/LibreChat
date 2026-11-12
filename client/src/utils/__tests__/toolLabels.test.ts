import { Constants } from 'librechat-data-provider';
import { parseToolName, getToolDisplayLabel, TOOL_FRIENDLY_NAME_KEYS } from '../toolLabels';
import * as labels from '../toolLabels';

describe('parseToolName', () => {
  it('splits an MCP tool id into server + tool name', () => {
    const parsed = parseToolName('search_code_mcp_github');
    expect(parsed).toEqual({
      raw: 'search_code_mcp_github',
      mcpServer: 'github',
      toolName: 'search_code',
    });
  });

  it('handles an MCP id whose tool-name portion contains underscores', () => {
    const parsed = parseToolName('deeply_nested_sub_tool_mcp_some-server');
    expect(parsed.mcpServer).toBe('some-server');
    expect(parsed.toolName).toBe('deeply_nested_sub_tool');
  });

  it('returns empty mcpServer + friendlyKey for a known native tool', () => {
    const parsed = parseToolName('web_search');
    expect(parsed).toEqual({
      raw: 'web_search',
      mcpServer: '',
      toolName: 'web_search',
      friendlyKey: TOOL_FRIENDLY_NAME_KEYS.web_search,
    });
  });

  it('returns empty mcpServer + no friendlyKey for an unknown native tool', () => {
    const parsed = parseToolName('custom_tool');
    expect(parsed).toEqual({
      raw: 'custom_tool',
      mcpServer: '',
      toolName: 'custom_tool',
    });
  });

  it('handles an MCP id with an empty server segment (pathological)', () => {
    /** `<tool>_mcp_` with nothing after the delimiter — treat as MCP
     *  with an empty server name rather than falling through to the
     *  native-tool path, so the display logic can surface "broken" ids
     *  rather than silently showing the whole thing as a tool name. */
    const parsed = parseToolName('foo_mcp_');
    expect(parsed.mcpServer).toBe('');
    expect(parsed.toolName).toBe('foo');
  });
});

describe('getToolDisplayLabel', () => {
  const identityLocalize = (key: string): string => key;

  it('returns the MCP server name for an MCP tool', () => {
    expect(getToolDisplayLabel('search_code_mcp_github', identityLocalize)).toBe('github');
  });

  it('returns the friendly translation key for a known native tool', () => {
    /** The identity-localize stub returns the translation key itself,
     *  which is what the real `useLocalize` would resolve at render time. */
    expect(getToolDisplayLabel('web_search', identityLocalize)).toBe(
      TOOL_FRIENDLY_NAME_KEYS.web_search,
    );
  });

  it('returns the code translation key for bash PTC tool calls', () => {
    expect(getToolDisplayLabel(Constants.BASH_PROGRAMMATIC_TOOL_CALLING, identityLocalize)).toBe(
      TOOL_FRIENDLY_NAME_KEYS[Constants.BASH_PROGRAMMATIC_TOOL_CALLING],
    );
  });

  it('returns the code translation key for bash_tool calls', () => {
    expect(getToolDisplayLabel('bash_tool', identityLocalize)).toBe(
      TOOL_FRIENDLY_NAME_KEYS.bash_tool,
    );
  });

  it('returns the raw name for an unknown native tool', () => {
    expect(getToolDisplayLabel('custom_tool', identityLocalize)).toBe('custom_tool');
  });
});

describe('kade.toolLabels from the stream (phase 3 A1)', () => {
  const localize = ((key: string) => key) as Parameters<typeof getToolDisplayLabel>[1];

  beforeEach(() => {
    localStorage.clear();
    labels.resetKadeToolLabelsForTest();
  });

  it('remembers the server label for each call by its index', () => {
    labels.rememberToolLabels({
      event: 'on_run_step',
      data: {
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ name: 'kade_known' }, {}, { function: { name: 'kade_drive_pc' } }],
        },
      },
      kade: { toolLabels: ['what I know', '', 'your computer'] },
    });
    expect(labels.kadeToolLabel('kade_known')).toBe('what I know');
    expect(labels.kadeToolLabel('kade_drive_pc')).toBe('your computer');
    expect(getToolDisplayLabel('kade_known', localize)).toBe('what I know');
    // survives a reload
    labels.resetKadeToolLabelsForTest();
    expect(labels.kadeToolLabel('kade_known')).toBe('what I know');
  });

  it('frames without labels and unknown names change nothing', () => {
    labels.rememberToolLabels({ event: 'on_run_step', data: { stepDetails: { tool_calls: [] } } });
    labels.rememberToolLabels(null);
    labels.rememberToolLabels('junk');
    expect(labels.kadeToolLabel('kade_known')).toBeUndefined();
    expect(getToolDisplayLabel('some_custom_tool', localize)).toBe('some_custom_tool');
  });

  it("the browser switch kadeToolLabels = '0' shows raw names", () => {
    labels.rememberToolLabels({
      data: { stepDetails: { tool_calls: [{ name: 'kade_known' }] } },
      kade: { toolLabels: ['what I know'] },
    });
    localStorage.setItem('kadeToolLabels', '0');
    expect(labels.kadeToolLabel('kade_known')).toBeUndefined();
    expect(getToolDisplayLabel('kade_known', localize)).toBe('kade_known');
  });
});
