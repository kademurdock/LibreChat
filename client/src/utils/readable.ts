import {
  CLEANUP_REGEX,
  LITERAL_NBSP_REGEX,
  BARE_CITATION_REGEX,
  INVALID_CITATION_REGEX,
} from '~/utils/citations';
import { stripVoiceTags, markdownToCleanProse } from '~/utils/voiceTags';
import { stripGameSoundTags } from '~/utils/gameSounds';

const THINKING_BLOCK_RE = /:::thinking[\s\S]*?:::\n?/g;
const THINK_TAG_RE = /<think>[\s\S]*?<\/think>/gi;
const PUA_RE = /[-]/g;
const MD_IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/g;
const MD_STAR_EMPHASIS_RE = /(^|[^\w*])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?![\w*])/g;
const MD_UNDERSCORE_EMPHASIS_RE = /(^|[^\w_])_([^\s_](?:[^_\n]*[^\s_])?)_(?![\w_])/g;

/**
 * Nov 12 2026 (WEB-4). Shared first stage for every "what a person reads" surface: reasoning
 * (:::thinking::: blocks and inline <think> tags), %%%voice tags%%%, [sound:]/[table:] cues and
 * markdown scaffolding gone. Citation markers are deliberately LEFT IN: the clipboard turns them
 * into [1] references (useCopyToClipboard.processCitations), so it must see them.
 */
export function stripHiddenMarkup(text: string): string {
  if (!text) {
    return text;
  }
  return markdownToCleanProse(
    stripGameSoundTags(
      stripVoiceTags(text.replace(THINKING_BLOCK_RE, '').replace(THINK_TAG_RE, '')),
    ),
  );
}

/**
 * Plain reading text (Reading View): the shared stage plus citation anchors and glyphs removed,
 * leftover emphasis/quote/image markers dropped, blank-line runs collapsed. Line structure is
 * kept (the view is white-space: pre-wrap). NOT for the clipboard -- it removes the citations
 * copy needs.
 */
export function toReadableText(text: string): string {
  if (!text) {
    return '';
  }
  return stripHiddenMarkup(text.replace(MD_IMAGE_RE, '$1'))
    .replace(INVALID_CITATION_REGEX, '')
    .replace(BARE_CITATION_REGEX, '')
    .replace(CLEANUP_REGEX, '')
    .replace(LITERAL_NBSP_REGEX, ' ')
    .replace(PUA_RE, '')
    .replace(MD_STAR_EMPHASIS_RE, '$1$2')
    .replace(MD_UNDERSCORE_EMPHASIS_RE, '$1$2')
    .replace(/^(\s*)[*•]\s+/gm, '$1- ')
    .replace(/^>\s?/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
