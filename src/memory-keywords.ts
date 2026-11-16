/**
 * Deterministic retrieval-key generation for Workspace Memory.
 *
 * The host never calls an LLM to decide what a memory is about. Both the write
 * side (per-item `search_keys`) and the query side (keywords extracted from a
 * user prompt) use the same rules:
 *
 * - CJK text (which the `simple` tsvector dictionary cannot segment) is split
 *   into runs at punctuation/whitespace, then sampled as 2–4 character
 *   n-grams.
 * - Latin and digit runs are split into words.
 * - Tokens that are pure stop words are dropped.
 *
 * The two sides are deliberately asymmetric in *selection*, not in tokenizing:
 * stored keys are graded by information density (longer grams and terms that
 * also appear in the title win), while query keywords keep every useful
 * 2-gram so a long natural-language question still contains the short key the
 * item was stored under. The SQL side matches stored keys and query keywords by
 * literal containment in both directions, so a 4-character stored key and a
 * 2-character query key still meet.
 */

export const MAX_SEARCH_KEYS = 12;
export const MIN_SEARCH_KEY_LENGTH = 1;
export const MAX_SEARCH_KEY_LENGTH = 32;
export const MAX_QUERY_KEYWORDS = 24;

/** Bound the content scanned for keys; Memory content can be 32k characters. */
const MAX_KEY_CONTENT_LENGTH = 4000;
const MAX_QUERY_LENGTH = 500;

const CJK_CHAR =
  '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]';
const TOKEN_PATTERN = new RegExp(
  `${CJK_CHAR}+|[a-z0-9]+(?:[._'-][a-z0-9]+)*`,
  'gu',
);
const CJK_RUN_PATTERN = new RegExp(`^${CJK_CHAR}+$`, 'u');

/**
 * Function words that carry no retrieval signal. Only whole tokens are
 * dropped: filtering individual characters would break real terms such as
 * 退款 or 下单.
 */
const CJK_STOP_WORDS = new Set([
  '的',
  '了',
  '是',
  '在',
  '和',
  '与',
  '及',
  '我',
  '你',
  '他',
  '她',
  '它',
  '我们',
  '你们',
  '他们',
  '她们',
  '咱们',
  '这个',
  '那个',
  '这些',
  '那些',
  '这样',
  '那样',
  '一个',
  '一些',
  '没有',
  '不是',
  '就是',
  '还有',
  '以及',
  '或者',
  '什么',
  '怎么',
  '怎样',
  '如何',
  '为何',
  '为什么',
  '可以',
  '能否',
  '是否',
  '需要',
  '应该',
  '如果',
  '因为',
  '所以',
  '但是',
  '而且',
  '然后',
  '现在',
  '今天',
  '明天',
  '昨天',
  '最近',
  '请问',
  '帮忙',
  '帮我',
  '一下',
  '的话',
  '以及',
  '对于',
  '关于',
  '根据',
  '通过',
  '进行',
  '目前',
  '这个',
  '那么',
  '这也',
  '那一',
  '我这边',
  '你这边',
]);

const LATIN_STOP_WORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'here',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'please',
  'she',
  'should',
  'so',
  'some',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

interface Token {
  text: string;
  cjk: boolean;
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function tokenize(value: string): Token[] {
  const text = normalizeText(value);
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const text = match[0];
    if (!text) continue;
    const cjk = CJK_RUN_PATTERN.test(text);
    if (cjk) {
      tokens.push({ text, cjk: true });
      continue;
    }
    if (text.length < 2) continue;
    if (LATIN_STOP_WORDS.has(text)) continue;
    tokens.push({ text, cjk: false });
  }
  return tokens;
}

function isStopWord(value: string): boolean {
  return CJK_STOP_WORDS.has(value) || LATIN_STOP_WORDS.has(value);
}

function* cjkGrams(run: string, sizes: readonly number[]): Generator<string> {
  for (const size of sizes) {
    if (run.length < size) continue;
    for (let index = 0; index + size <= run.length; index += 1) {
      yield run.slice(index, index + size);
    }
  }
}

function lengthWeight(size: number): number {
  // Longer CJK grams are more specific; that is the only way this algorithm
  // ranks candidates without a dictionary.
  if (size >= 4) return 1.5;
  if (size === 3) return 1.3;
  return 1;
}

interface ScoredKey {
  key: string;
  score: number;
}

function collectKeyCandidates(input: {
  title?: string | null;
  canonicalKey?: string | null;
  content?: string | null;
}): Map<string, number> {
  const scores = new Map<string, number>();
  const add = (key: string, weight: number): void => {
    if (!key) return;
    if (key.length > MAX_SEARCH_KEY_LENGTH) return;
    if (isStopWord(key)) return;
    scores.set(key, (scores.get(key) ?? 0) + weight);
  };
  const scan = (value: string | null | undefined, weight: number): void => {
    if (!value) return;
    for (const token of tokenize(value.slice(0, MAX_KEY_CONTENT_LENGTH))) {
      if (token.cjk) {
        if (token.text.length < 2) continue;
        for (const gram of cjkGrams(token.text, [2, 3, 4])) {
          add(gram, weight * lengthWeight(gram.length));
        }
        continue;
      }
      add(token.text, weight);
    }
  };
  // Title and canonical key are curated labels, so they outweigh body text:
  // the retired bm25 weights were 3/2/1 for title/canonical_key/content.
  scan(input.title, 3);
  scan(input.canonicalKey, 2);
  scan(input.content, 1);
  return scores;
}

/**
 * Normalize agent- or user-supplied keys: NFKC + lowercase, collapse inner
 * whitespace, drop empty entries, dedupe, and cap at `MAX_SEARCH_KEYS`.
 */
export function normalizeSearchKeys(
  values: readonly unknown[] | null | undefined,
): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const key = value
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (!key) continue;
    if (key.length < MIN_SEARCH_KEY_LENGTH) continue;
    if (key.length > MAX_SEARCH_KEY_LENGTH) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    if (keys.length >= MAX_SEARCH_KEYS) break;
  }
  return keys;
}

/** Describe why an explicitly supplied key list is unusable, if it is. */
export function searchKeysInputError(
  values: readonly unknown[] | null | undefined,
): string | null {
  if (values === null || values === undefined) return null;
  if (!Array.isArray(values)) return 'searchKeys must be an array of strings';
  if (values.length > MAX_SEARCH_KEYS) {
    return `searchKeys supports at most ${MAX_SEARCH_KEYS} entries`;
  }
  for (const value of values) {
    if (typeof value !== 'string') {
      return 'searchKeys entries must be strings';
    }
    const key = value.normalize('NFKC').trim();
    if (key.length < MIN_SEARCH_KEY_LENGTH) {
      return 'searchKeys entries must not be empty';
    }
    if (key.length > MAX_SEARCH_KEY_LENGTH) {
      return `searchKeys entries must be at most ${MAX_SEARCH_KEY_LENGTH} characters`;
    }
  }
  return null;
}

/**
 * Write-side keys. Deterministic for the same item text, so re-deriving an
 * unchanged item produces an identical list and no spurious diffs.
 */
export function deriveSearchKeys(input: {
  title?: string | null;
  canonicalKey?: string | null;
  content?: string | null;
}): string[] {
  const candidates: ScoredKey[] = [...collectKeyCandidates(input)].map(
    ([key, score]) => ({ key, score }),
  );
  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      right.key.length - left.key.length ||
      (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
  );
  const selected: string[] = [];
  for (const candidate of candidates) {
    if (selected.length >= MAX_SEARCH_KEYS) break;
    // Comparing against already-selected keys keeps the list to distinct
    // terms instead of every overlapping n-gram of the same phrase.
    if (
      selected.some(
        (key) => key.includes(candidate.key) || candidate.key.includes(key),
      )
    ) {
      continue;
    }
    selected.push(candidate.key);
  }
  selected.sort();
  return selected;
}

/**
 * Query-side keywords. Unlike the write side this keeps every useful 2-gram,
 * because a long Chinese question only meets a short stored key if the short
 * gram survives selection.
 */
export function deriveQueryKeywords(query: string): string[] {
  const text = query.slice(0, MAX_QUERY_LENGTH);
  const tokens = tokenize(text);
  const keywords: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    if (keywords.length >= MAX_QUERY_KEYWORDS) return;
    if (!value) return;
    if (value.length > MAX_SEARCH_KEY_LENGTH) return;
    if (isStopWord(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    keywords.push(value);
  };

  // 1. Latin/digit words are already words, so they need no sampling.
  for (const token of tokens) {
    if (!token.cjk) push(token.text);
  }
  // 2. A short CJK run is a term in its own right.
  for (const token of tokens) {
    if (token.cjk && token.text.length >= 2 && token.text.length <= 4) {
      push(token.text);
    }
  }
  // 3. Every 2-gram of a longer run, so shorter stored keys still match.
  for (const token of tokens) {
    if (token.cjk && token.text.length > 4) {
      for (const gram of cjkGrams(token.text, [2])) push(gram);
    }
  }
  // 4. Longer grams add specificity when there is budget left.
  for (const token of tokens) {
    if (token.cjk && token.text.length > 4) {
      for (const gram of cjkGrams(token.text, [3, 4])) push(gram);
    }
  }
  return keywords;
}

/**
 * `to_tsquery` expression matching any keyword as a whole lexeme. Keywords
 * containing whitespace are skipped: they are not single lexemes under the
 * `simple` configuration, and the ILIKE arm still covers them.
 */
export function keywordsToTsQuery(keywords: readonly string[]): string {
  const terms = keywords
    .filter((keyword) => keyword && !/\s/.test(keyword))
    .map((keyword) => `'${keyword.replaceAll("'", "''")}'`);
  return terms.join(' | ');
}
