import { Tools, replaceSpecialVars } from 'librechat-data-provider';
import { quantizeTimeAnchor } from '~/utils/timeAnchor';

/** Builds the web search tool context with citation format instructions. */
export function buildWebSearchContext(): string {
  return `# \`${Tools.web_search}\`:
**Execute immediately without preface.** After search, provide a brief summary addressing the query directly, then structure your response with clear Markdown formatting (## headers, lists, tables). Cite sources properly, tailor tone to query type, and provide comprehensive details.

Use the conversation date/time from the dynamic runtime context when recency matters.

**CITATION FORMAT - UNICODE ESCAPE SEQUENCES ONLY:**
Use these EXACT escape sequences (copy verbatim): \\ue202 (before each anchor), \\ue200 (group start), \\ue201 (group end), \\ue203 (highlight start), \\ue204 (highlight end)

Anchor pattern: \\ue202turn{N}{type}{index} where N=turn number, type=search|news|image|ref, index=0,1,2...

**Examples (copy these exactly):**
- Single: "Statement.\\ue202turn0search0"
- Multiple: "Statement.\\ue202turn0search0\\ue202turn0news1"
- Group: "Statement. \\ue200\\ue202turn0search0\\ue202turn0news1\\ue201"
- Highlight: "\\ue203Cited text.\\ue204\\ue202turn0search0"
- Image: "See photo\\ue202turn0image0."

**CRITICAL:** Output escape sequences EXACTLY as shown. Do NOT substitute with † or other symbols. Place anchors AFTER punctuation. Cite every non-obvious fact/quote. NEVER use markdown links, [1], footnotes, or HTML tags. These escape sequences are ONLY for citation anchors — never write escape-sequence text (like \\u00a0) anywhere else in your reply; type normal spaces and characters.`.trim();
}

/** Builds dynamic web search context scoped to the conversation anchor time.
 * KADE July 22 2026: the anchor is quantized (LC_TIME_ANCHOR_QUANTUM_MIN,
 * default 60 min) so this line — which rides the injected context message on
 * EVERY request — renders byte-identical within a window instead of mutating
 * per request and killing the Moonshot prompt cache (see utils/timeAnchor). */
export function buildWebSearchDynamicContext(now?: string | number | Date): string {
  return `# \`${Tools.web_search}\` Runtime Context
Conversation Date & Time: ${replaceSpecialVars({ text: '{{iso_datetime}}', now: quantizeTimeAnchor(now) })}`.trim();
}
