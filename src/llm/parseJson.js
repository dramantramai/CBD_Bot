/**
 * Models sometimes wrap JSON in prose or a markdown fence despite instructions.
 * Pull out the first balanced object rather than failing the whole extraction.
 */
function parseJsonLoose(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Empty response from model');

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();

  try {
    return JSON.parse(candidate);
  } catch (_) {
    // fall through to brace scanning
  }

  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in model response');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error('Unterminated JSON object in model response');
}

module.exports = { parseJsonLoose };
