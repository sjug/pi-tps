/** Han, Hiragana, Katakana, Hangul — BPE packs several of these per token. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}_]/u;

const CJK_CHARS_PER_TOKEN = 1.8;
const LATIN_CHARS_PER_TOKEN = 4;
const NEWLINE_TOKENS = 0.25;

/**
 * Approximate tokens in a streamed delta.
 *
 * Fractional on purpose: rounding each chunk would bias chunky streams up.
 * CJK is counted separately because JS `\w` is ASCII-only and would score
 * every Han character as a full token.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let tokens = 0;
  let cjk = 0;
  let latin = 0;

  for (const ch of text) {
    if (CJK.test(ch)) {
      cjk++;
      continue;
    }
    if (LETTER_OR_DIGIT.test(ch)) {
      latin++;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (ch === "\n") tokens += NEWLINE_TOKENS;
      continue;
    }
    tokens += 1;
  }

  return tokens + cjk / CJK_CHARS_PER_TOKEN + latin / LATIN_CHARS_PER_TOKEN;
}
