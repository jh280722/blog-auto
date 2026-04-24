const DEFAULT_TISTORY_MAX_TAGS = 3;

export function normalizeTistoryTagValue(value) {
  return String(value ?? '')
    .trim()
    .replace(/^#+/, '')
    .trim();
}

export function normalizeTistoryTagsForInput(tags = [], options = {}) {
  const maxTags = Number.isFinite(Number(options.maxTags))
    ? Math.max(0, Number(options.maxTags))
    : DEFAULT_TISTORY_MAX_TAGS;
  const seen = new Set();
  const normalized = [];

  for (const rawTag of Array.isArray(tags) ? tags : []) {
    const tag = normalizeTistoryTagValue(rawTag);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
    if (normalized.length >= maxTags) break;
  }

  return normalized;
}
