const BLOG_IMAGE_POLICY_VERSION = 'hermes-image-generate-v1';
const REQUIRED_TOOL_LABEL = 'Hermes image_generate';
const REQUIRED_RUNNER = 'openai-codex';
const REQUIRED_MODEL = 'gpt-image-2-medium';
const BODY_IMAGE_POLICY_ACTIONS = new Set(['WRITE_POST', 'ADD_TO_QUEUE']);

const DISALLOWED_GENERATED_ROUTE_RE = /\b(?:pil|pillow|baoyu|baoyu-[a-z-]+|infographic\s*script|handmade\s*infographic|manual\s*infographic|python\s*infographic)\b/i;
const GENERATED_FLAG_RE = /\b(?:generated|ai[-_\s]*generated|synthetic|hero[-_\s]*image|body[-_\s]*image)\b/i;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToken(value = '') {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9.-]+/g, '-');
}

function textIncludes(value, needle) {
  return String(value ?? '').toLowerCase().includes(String(needle).toLowerCase());
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function collectRouteText(image = {}) {
  const generation = isPlainObject(image.generation) ? image.generation : {};
  const provenance = isPlainObject(image.provenance) ? image.provenance : {};
  const meta = isPlainObject(image.meta) ? image.meta : {};
  return [
    image.generator,
    image.provider,
    image.source,
    image.sourceKind,
    image.createdBy,
    image.pipeline,
    image.tool,
    image.runner,
    image.model,
    generation.tool,
    generation.provider,
    generation.source,
    generation.sourceKind,
    generation.createdBy,
    generation.pipeline,
    generation.runner,
    generation.model,
    generation.backend,
    provenance.tool,
    provenance.provider,
    provenance.source,
    provenance.runner,
    provenance.model,
    meta.tool,
    meta.provider,
    meta.source,
    meta.runner,
    meta.model
  ].filter((value) => value != null).map(String).join(' ');
}

function hasExplicitGeneratedFlag(image = {}) {
  if (!isPlainObject(image)) return false;
  if (image.generated === true || image.isGenerated === true || image.aiGenerated === true) return true;
  if (isPlainObject(image.generation)) return true;
  if (isPlainObject(image.provenance) && image.provenance.generated === true) return true;
  const routeText = collectRouteText(image);
  return GENERATED_FLAG_RE.test(routeText);
}

function isHermesImageGenerateRoute(image = {}) {
  const generation = isPlainObject(image.generation) ? image.generation : {};
  const provenance = isPlainObject(image.provenance) ? image.provenance : {};
  const meta = isPlainObject(image.meta) ? image.meta : {};

  const tool = firstString(generation.tool, provenance.tool, meta.tool, image.tool, image.generator, image.provider, image.createdBy);
  const runner = firstString(generation.runner, provenance.runner, meta.runner, image.runner, image.createdBy);
  const model = firstString(generation.model, provenance.model, meta.model, image.model);
  const pipeline = firstString(generation.pipeline, provenance.pipeline, meta.pipeline, image.pipeline, generation.source, image.source);

  const toolOk = textIncludes(tool, 'hermes image_generate')
    || textIncludes(tool, 'image_generate')
    || textIncludes(pipeline, 'hermes image_generate')
    || textIncludes(pipeline, 'image_generate');
  const runnerOk = normalizeToken(runner) === REQUIRED_RUNNER
    || textIncludes(runner, REQUIRED_RUNNER)
    || textIncludes(pipeline, REQUIRED_RUNNER);
  const modelOk = normalizeToken(model) === REQUIRED_MODEL
    || textIncludes(model, REQUIRED_MODEL)
    || textIncludes(pipeline, REQUIRED_MODEL);

  return toolOk && runnerOk && modelOk;
}

function inferImageUrl(image = {}) {
  return firstString(image.url, image.src, image.href, image.dataUrl);
}

function summarizeImageForPolicy(image = {}, index = 0, origin = 'payload.images') {
  const generation = isPlainObject(image.generation) ? image.generation : {};
  const provenance = isPlainObject(image.provenance) ? image.provenance : {};
  const meta = isPlainObject(image.meta) ? image.meta : {};
  const routeText = collectRouteText(image);
  const isGenerated = hasExplicitGeneratedFlag(image);
  const disallowedRoute = DISALLOWED_GENERATED_ROUTE_RE.test(routeText);
  const allowedRoute = isGenerated && isHermesImageGenerateRoute(image);

  return {
    index,
    origin,
    url: inferImageUrl(image) || null,
    alt: firstString(image.alt, image.title) || null,
    generated: isGenerated,
    route: allowedRoute ? 'hermes_image_generate_openai_codex_gpt_image_2_medium' : null,
    generation: {
      tool: firstString(generation.tool, provenance.tool, meta.tool, image.tool, image.generator, image.provider) || null,
      runner: firstString(generation.runner, provenance.runner, meta.runner, image.runner) || null,
      model: firstString(generation.model, provenance.model, meta.model, image.model) || null
    },
    disallowedRoute
  };
}

function extractAttributeValue(tag, names = []) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = tag.match(regex);
    if (match) return match[1] ?? match[2] ?? match[3] ?? '';
  }
  return '';
}

function imageFromHtmlTag(tag, index) {
  const generatedAttr = extractAttributeValue(tag, ['data-generated', 'data-generated-image', 'data-ai-generated']);
  const tool = extractAttributeValue(tag, ['data-generation-tool', 'data-generator', 'data-tool', 'data-provider']);
  const runner = extractAttributeValue(tag, ['data-generation-runner', 'data-runner']);
  const model = extractAttributeValue(tag, ['data-generation-model', 'data-model']);
  const pipeline = extractAttributeValue(tag, ['data-generation-pipeline', 'data-pipeline']);
  return {
    url: extractAttributeValue(tag, ['src']),
    alt: extractAttributeValue(tag, ['alt']),
    generated: /^(?:1|true|yes|generated|ai)$/i.test(generatedAttr),
    generation: (tool || runner || model || pipeline) ? {
      tool,
      runner,
      model,
      pipeline
    } : undefined,
    originIndex: index
  };
}

function extractImagesFromHtml(html = '') {
  const images = [];
  const source = String(html ?? '');
  const imgRe = /<img\b[^>]*>/gi;
  let match;
  let index = 0;
  while ((match = imgRe.exec(source))) {
    images.push(imageFromHtmlTag(match[0], index));
    index += 1;
  }
  return images;
}

function extractPayloadCandidates(payload, path = 'payload') {
  const candidates = [];
  if (Array.isArray(payload)) {
    payload.forEach((item, index) => {
      candidates.push(...extractPayloadCandidates(item, `${path}[${index}]`));
    });
    return candidates;
  }
  if (!isPlainObject(payload)) return candidates;

  candidates.push({ payload, path });

  for (const key of ['items', 'posts', 'queue', 'entries']) {
    if (Array.isArray(payload[key])) {
      payload[key].forEach((item, index) => {
        candidates.push(...extractPayloadCandidates(item, `${path}.${key}[${index}]`));
      });
    }
  }

  return candidates;
}

function validateBlogAutoPayloadImagePolicy(payload = {}) {
  const entries = [];
  const candidates = extractPayloadCandidates(payload);
  for (const candidate of candidates) {
    const images = Array.isArray(candidate.payload.images) ? candidate.payload.images : [];
    images.forEach((image, index) => {
      if (!isPlainObject(image)) return;
      entries.push(summarizeImageForPolicy(image, index, `${candidate.path}.images`));
    });

    extractImagesFromHtml(candidate.payload.content || candidate.payload.html || '').forEach((image, index) => {
      entries.push(summarizeImageForPolicy(image, index, `${candidate.path}.content`));
    });
  }

  const violations = [];
  entries.forEach((entry) => {
    if (!entry.generated) return;
    if (entry.route && !entry.disallowedRoute) return;
    const routeText = [entry.generation.tool, entry.generation.runner, entry.generation.model].filter(Boolean).join(' ') || 'missing generation metadata';
    violations.push({
      reason: entry.disallowedRoute ? 'generated_image_disallowed_route' : 'generated_image_missing_required_route',
      origin: entry.origin,
      index: entry.index,
      url: entry.url,
      generation: entry.generation,
      message: `Generated blog body images must use ${REQUIRED_TOOL_LABEL} via ${REQUIRED_RUNNER} / ${REQUIRED_MODEL}; found ${routeText}. PIL/Pillow, baoyu-* and handmade infographic fallback routes are not allowed as defaults.`
    });
  });

  const generatedImageCount = entries.filter((entry) => entry.generated).length;
  const unmarkedImageCount = entries.filter((entry) => !entry.generated).length;

  return {
    ok: violations.length === 0,
    policyVersion: BLOG_IMAGE_POLICY_VERSION,
    requiredRoute: {
      tool: REQUIRED_TOOL_LABEL,
      runner: REQUIRED_RUNNER,
      model: REQUIRED_MODEL
    },
    totalImageCount: entries.length,
    generatedImageCount,
    unmarkedImageCount,
    violations,
    images: entries
  };
}

function buildBodyImagePolicyReport({ action, payload }) {
  return {
    action,
    ...validateBlogAutoPayloadImagePolicy(payload)
  };
}

function shouldValidateBodyImagePolicy(action) {
  return BODY_IMAGE_POLICY_ACTIONS.has(action);
}

function buildBodyImagePolicyActionGuard({ action, payload }) {
  if (!shouldValidateBodyImagePolicy(action)) return null;
  const report = buildBodyImagePolicyReport({ action, payload });
  if (report.ok) return null;
  return buildBodyImagePolicyFailureResult({ action, report });
}

function buildBodyImagePolicyFailureResult({ action, report }) {
  return {
    success: false,
    status: 'body_image_policy_violation',
    action,
    error: `Generated blog body image route policy failed: ${report.violations.length} violation(s). Use Hermes image_generate via openai-codex / gpt-image-2-medium, or mark product/external images as non-generated by omitting generated metadata.`,
    bodyImagePolicy: report
  };
}

export {
  BLOG_IMAGE_POLICY_VERSION,
  BODY_IMAGE_POLICY_ACTIONS,
  REQUIRED_MODEL,
  REQUIRED_RUNNER,
  REQUIRED_TOOL_LABEL,
  buildBodyImagePolicyActionGuard,
  buildBodyImagePolicyFailureResult,
  buildBodyImagePolicyReport,
  extractImagesFromHtml,
  shouldValidateBodyImagePolicy,
  validateBlogAutoPayloadImagePolicy
};
