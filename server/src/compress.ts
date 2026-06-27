/**
 * Local, dependency-free tool-output compaction (headroom-style).
 *
 * The biggest token sink in an agent loop is large tool outputs (scraped pages,
 * GitHub READMEs, web fetches, big JSON) being fed back into the model. This
 * shrinks them before they reach the LLM:
 *   1. whitespace / boilerplate collapse  (lossless-ish, free)
 *   2. head+tail cap for very large payloads, with a marker the agent can act on
 *
 * It is intentionally conservative and reversible-by-asking: the agent is told
 * how to fetch the full content if it actually needs it.
 */

/** Collapse redundant whitespace — free, near-lossless. */
export function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Compact a large text tool output to roughly `maxChars`, keeping the
 * informative head and tail. Returns the original if already small.
 */
export function compactText(text: string, maxChars = 8000): string {
  const t = collapseWhitespace(text);
  if (t.length <= maxChars) return t;
  const headLen = Math.floor(maxChars * 0.72);
  const tailLen = Math.floor(maxChars * 0.2);
  const head = t.slice(0, headLen);
  const tail = t.slice(-tailLen);
  const dropped = t.length - head.length - tail.length;
  return `${head}\n\n…[${dropped.toLocaleString()} characters trimmed here to save tokens — if you need the full content, say so and re-fetch/kb_read it]…\n\n${tail}`;
}

/** Rough token estimate (≈4 chars/token) for logging savings. */
export const approxTokens = (s: string): number => Math.ceil(s.length / 4);
