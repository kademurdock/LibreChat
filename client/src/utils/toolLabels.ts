import { Constants } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { kadeSwitchOn } from './kadeSwitch';

/**
 * Shared tool-name parsing + friendly-label mapping used by the main
 * tool-call UI and the subagent ticker. Centralized so the MCP
 * delimiter (`<tool>_mcp_<server>`) and native-tool short names read
 * consistently in every surface that renders tool lifecycle.
 */

/** Native tool id → translation key for a user-readable short name. */
export const TOOL_FRIENDLY_NAME_KEYS: Record<string, TranslationKeys> = {
  execute_code: 'com_ui_tool_name_code',
  run_tools_with_code: 'com_ui_tool_name_code',
  run_tools_with_bash: 'com_ui_tool_name_code',
  bash_tool: 'com_ui_tool_name_code',
  web_search: 'com_ui_tool_name_web_search',
  image_gen_oai: 'com_ui_tool_name_image_gen',
  image_edit_oai: 'com_ui_tool_name_image_edit',
  gemini_image_gen: 'com_ui_tool_name_image_gen',
  file_search: 'com_ui_tool_name_file_search',
  code_interpreter: 'com_ui_tool_name_code_analysis',
  retrieval: 'com_ui_tool_name_file_search',
};

export interface ParsedToolName {
  /** Original tool id (unchanged). */
  raw: string;
  /** MCP server name when the tool follows `<tool>_mcp_<server>`, else `''`. */
  mcpServer: string;
  /** Tool-specific name — the `<tool>` half of an MCP id, or the raw
   *  name for native tools. Useful as the "action" label shown in a
   *  code-style badge next to the server name. */
  toolName: string;
  /** Translation key for a user-friendly display name, when the raw
   *  name matches a built-in native tool (web_search, execute_code, …).
   *  Absent for MCP tools and unknown names. */
  friendlyKey?: TranslationKeys;
}

/**
 * Split an incoming tool id into its constituent parts:
 *
 *   - `search_code_mcp_github` → `{ mcpServer: 'github', toolName: 'search_code' }`
 *   - `web_search`             → `{ mcpServer: '', toolName: 'web_search', friendlyKey: 'com_ui_tool_name_web_search' }`
 *   - `some_custom_tool`       → `{ mcpServer: '', toolName: 'some_custom_tool' }`
 */
export function parseToolName(rawName: string): ParsedToolName {
  const idx = rawName.indexOf(Constants.mcp_delimiter);
  if (idx >= 0) {
    const mcpServer = rawName.slice(idx + Constants.mcp_delimiter.length);
    const toolName = rawName.slice(0, idx);
    return { raw: rawName, mcpServer, toolName };
  }
  const friendlyKey = TOOL_FRIENDLY_NAME_KEYS[rawName];
  return {
    raw: rawName,
    mcpServer: '',
    toolName: rawName,
    ...(friendlyKey ? { friendlyKey } : {}),
  };
}

/**
 * Resolve a tool id to a single user-facing short label. Pure string —
 * use `parseToolName` directly when you need structured parts (e.g. to
 * render a code-style badge for the tool name next to the server).
 *
 *   - MCP tool  → server name (keeps the header summary short)
 *   - Native   → localized friendly name from {@link TOOL_FRIENDLY_NAME_KEYS}
 *   - Unknown  → raw name
 */
export function getToolDisplayLabel(
  rawName: string,
  localize: (key: TranslationKeys) => string,
): string {
  const parsed = parseToolName(rawName);
  if (parsed.mcpServer) return parsed.mcpServer;
  if (parsed.friendlyKey) return localize(parsed.friendlyKey);
  return kadeToolLabel(parsed.toolName) ?? parsed.toolName;
}

/* Nov 12 2026 (platform audit, phase 3 A1): the server names every tool beside its run step,
 * { event: 'on_run_step', data, kade: { toolLabels: [...] } }, toolLabels[i] for tool_calls[i]
 * (api/server/services/kadeToolLabels.js). This browser remembers name -> label, so "kade_known"
 * shows and reads as "what I know", also after a reload. Undo on one browser: localStorage
 * kadeToolLabels = '0'. */
const KADE_TOOL_LABELS_KEY = 'kadeToolLabelNames';
const KADE_TOOL_LABELS_MAX = 120;
let kadeLabels: Record<string, string> | null = null;

function loadKadeLabels(): Record<string, string> {
  if (kadeLabels) return kadeLabels;
  kadeLabels = {};
  try {
    const raw = globalThis.localStorage?.getItem(KADE_TOOL_LABELS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [name, label] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof label === 'string' && label) kadeLabels[name] = label;
      }
    }
  } catch {
    /* storage blocked or bad JSON: start empty */
  }
  return kadeLabels;
}

/** The server's label for a tool name this browser has seen, or undefined. */
export function kadeToolLabel(rawName: string): string | undefined {
  if (!rawName || !kadeSwitchOn('toolLabels')) return undefined;
  const labels = loadKadeLabels();
  return Object.prototype.hasOwnProperty.call(labels, rawName) ? labels[rawName] : undefined;
}

type ToolCallLike = { name?: unknown; function?: { name?: unknown } } | null | undefined;

/** Reads kade.toolLabels off one stream frame. Never throws; frames without it are ignored. */
export function rememberToolLabels(frame: unknown): void {
  try {
    if (!frame || typeof frame !== 'object' || !kadeSwitchOn('toolLabels')) return;
    const { kade, data } = frame as {
      kade?: { toolLabels?: unknown };
      data?: { stepDetails?: { tool_calls?: unknown } };
    };
    const toolLabels = kade?.toolLabels;
    const calls = data?.stepDetails?.tool_calls;
    if (!Array.isArray(toolLabels) || !Array.isArray(calls)) return;
    const labels = loadKadeLabels();
    let changed = false;
    calls.forEach((call: ToolCallLike, i: number) => {
      const name = call?.name ?? call?.function?.name;
      const label = toolLabels[i];
      if (typeof name !== 'string' || !name || typeof label !== 'string' || !label) return;
      if (name === label || labels[name] === label) return;
      labels[name] = label;
      changed = true;
    });
    if (!changed) return;
    const names = Object.keys(labels);
    if (names.length > KADE_TOOL_LABELS_MAX) {
      for (const old of names.slice(0, names.length - KADE_TOOL_LABELS_MAX)) delete labels[old];
    }
    globalThis.localStorage?.setItem(KADE_TOOL_LABELS_KEY, JSON.stringify(labels));
  } catch {
    /* a label is a nicety; the raw name still shows */
  }
}

/** Tests only. */
export function resetKadeToolLabelsForTest(): void {
  kadeLabels = null;
}
