const { env } = require('../config/env');
const logger = require('../utils/logger');
const schema = require('./schema.json');
const checkboxMap = require('../docgen/checkboxMap.json');
const mockExtractor = require('./mockExtractor');

const gemini = require('./gemini');
const groq = require('./groq');
const huggingface = require('./huggingface');

// Blueprint 7.2: Gemini first, then Groq, then Hugging Face.
const CHAIN = [gemini, groq, huggingface];

const STRING_FIELDS = Object.entries(schema.properties)
  .filter(([, v]) => v.type === 'string')
  .map(([k]) => k);

// Valid options per group, straight from the template.
const VALID = {};
for (const v of Object.values(checkboxMap)) {
  (VALID[v.group] ||= new Set()).add(v.label);
}

// Overflow cells that exist only to catch options the checkboxes miss. Empty is
// the normal answer, so they are never flagged for review.
const OPTIONAL_FIELDS = new Set([
  'otherMentions',
  'releasePlatformOther',
  'languageMediumOther',
  'accentOther',
  'availableResourcesOther',
  'projectOwnerPhone',
]);

const FALLBACKS = {
  launchDate: 'TBD, confirm with client',
  keyMessage: 'To be refined post-brief',
  callToAction: 'To be defined',
};

/**
 * A model's output is untrusted: it can invent checkbox labels, return numbers
 * where strings belong, or omit fields entirely. Normalizing here means
 * fillTemplate only ever sees a well-formed object.
 */
function normalize(raw, { meeting } = {}) {
  const out = {};

  for (const field of STRING_FIELDS) {
    const value = raw[field];
    out[field] =
      value === undefined || value === null
        ? ''
        : Array.isArray(value)
          ? value.filter(Boolean).join('\n')
          : String(value).trim();
  }

  // Owner details come from the calendar, not the transcript, so they win.
  const owner = (meeting && meeting.dramantramUser) || {};
  if (owner.displayName) out.projectOwnerName = owner.displayName;
  if (owner.email) out.projectOwnerEmail = owner.email;
  if (owner.phone) out.projectOwnerPhone = owner.phone;

  const overview = Array.isArray(raw.clientOrgOverview) ? raw.clientOrgOverview : [];
  out.clientOrgOverview = [
    String(overview[0] || '').trim(),
    String(overview[1] || '').trim(),
  ];

  out.checkboxes = {};
  const dropped = [];
  for (const [group, labels] of Object.entries(raw.checkboxes || {})) {
    const allowed = VALID[group];
    if (!allowed) {
      dropped.push(group);
      continue;
    }
    const picked = (Array.isArray(labels) ? labels : [labels])
      .map((l) => String(l).trim())
      .filter((l) => {
        if (allowed.has(l)) return true;
        dropped.push(`${group}:${l}`);
        return false;
      });
    if (picked.length) out.checkboxes[group] = [...new Set(picked)];
  }
  if (dropped.length) {
    logger.warn({ dropped }, 'Discarded checkbox values not present in the template');
  }

  out.confidence = {};
  for (const field of STRING_FIELDS) {
    const score = Number((raw.confidence || {})[field]);
    out.confidence[field] = Number.isFinite(score)
      ? Math.min(5, Math.max(1, Math.round(score)))
      : 1;
  }

  // Apply the blueprint's documented fallbacks for anything left blank.
  for (const [field, fallback] of Object.entries(FALLBACKS)) {
    if (!out[field]) {
      out[field] = fallback;
      out.confidence[field] = Math.min(out.confidence[field], 2);
    }
  }

  for (const field of OPTIONAL_FIELDS) {
    if (!out[field]) out.confidence[field] = 3;
  }

  const scores = Object.values(out.confidence);
  out.confidenceAvg = scores.length
    ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2))
    : 0;
  out.needsConfirmation = STRING_FIELDS.filter((f) => out.confidence[f] < 3);
  out._provider = raw._provider || 'unknown';

  return out;
}

function providerChain() {
  if (env.MOCK_MODE) return [];
  return CHAIN.filter((p) => p.isConfigured());
}

/**
 * Runs the transcript through the first provider that works. Falls back to the
 * offline heuristic extractor when mock mode is on or no provider has a key,
 * so the pipeline always produces a document.
 */
async function extractCBD({ transcript, meeting }, options = {}) {
  const chain = options.chain || providerChain();
  const errors = [];

  for (const provider of chain) {
    try {
      logger.info({ provider: provider.name }, 'Extracting CBD fields');
      const raw = await provider.extract({ transcript, meeting });
      return normalize(raw, { meeting });
    } catch (err) {
      errors.push(`${provider.name}: ${err.message}`);
      logger.warn(
        { provider: provider.name, err: err.message },
        'Provider failed, falling through'
      );
    }
  }

  if (errors.length) {
    logger.error({ errors }, 'Every LLM provider failed; using offline extractor');
  } else {
    logger.info(
      env.MOCK_MODE
        ? 'MOCK_MODE on: using the offline heuristic extractor'
        : 'No LLM API key configured: using the offline heuristic extractor'
    );
  }

  const raw = mockExtractor.extract({ transcript, meeting });
  const result = normalize(raw, { meeting });
  result._providerErrors = errors;
  return result;
}

module.exports = { extractCBD, normalize, providerChain, CHAIN, VALID, STRING_FIELDS };
