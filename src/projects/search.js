const { listProjects, projectLabel } = require('../db/projects');

/**
 * Finding a project among hundreds. Every word typed must appear in the client or project name (any
 * order, any case, partial words fine: "verd kit" finds "Verdant Kitchens - Video"). Names that
 * start with what was typed come first, then the most recently active.
 */

const words = (text) => String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function searchProjects(query, { limit = 15 } = {}) {
  const wanted = words(query);
  const all = listProjects().filter((p) => !p.cleared_at); // most recently active first
  if (!wanted.length) return all.slice(0, limit);

  const scored = [];
  all.forEach((p, recency) => {
    const name = `${p.client_name} ${p.project_name} ${projectLabel(p)}`.toLowerCase();
    if (!wanted.every((w) => name.includes(w))) return;
    const starts = `${p.client_name} ${p.project_name}`.toLowerCase().startsWith(String(query).trim().toLowerCase());
    scored.push({ p, rank: (starts ? 0 : 1) * 1e6 + recency });
  });
  return scored.sort((a, b) => a.rank - b.rank).slice(0, limit).map((s) => s.p);
}

const titleOf = (p) => `${p.client_name} - ${p.project_name}`;

module.exports = { searchProjects, titleOf };
