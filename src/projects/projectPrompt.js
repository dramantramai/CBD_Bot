const logger = require('../utils/logger');
const { buildProjectCard } = require('../bot/cards');
const { listProjects, getProject, createProject, findByName } = require('../db/projects');

// "userId::meetingId" -> { resolve, timer, suggestionId }
const pending = new Map();
const key = (meetingId, userId) => `${userId}::${meetingId}`;

const PROMPT_MINUTES = 30;

/**
 * Asks which project a client brief belongs to and waits for the answer.
 * Resolves { project, created } for a choice, or { project: null } if nobody
 * answered in time (the brief is then made without a project, and says so).
 * Held in memory: the question follows the Yes by seconds, so a restart in
 * between is rare, and asking again costs one message.
 */
function askProject({ meeting, userId, send, suggestion, timeoutMs }) {
  const id = key(meeting.id, userId);
  if (pending.has(id)) return pending.get(id).promise;

  let resolve;
  const promise = new Promise((r) => (resolve = r));
  const timer = setTimeout(() => {
    logger.info({ meetingId: meeting.id }, 'Project question timed out; briefing without a project');
    pending.delete(id);
    resolve({ project: null });
  }, timeoutMs ?? PROMPT_MINUTES * 60 * 1000);
  if (timer.unref) timer.unref();

  pending.set(id, { promise, resolve, timer, suggestionId: suggestion && suggestion.project.id });
  send(buildProjectCard({ meetingId: meeting.id, title: meeting.subject, suggestion, projects: listProjects().filter((p) => !p.cleared_at) }));
  return promise;
}

/**
 * A button on the project card was pressed. Returns { ok, message }: a problem
 * with what was typed keeps the question open, anything else settles it.
 */
function answerProject({ meetingId, userId, value, createdBy }) {
  const id = key(meetingId, userId);
  const entry = pending.get(id);
  if (!entry) return { ok: false, message: 'I am no longer waiting on that question.' };

  let project;
  let created = false;
  if (value.mode === 'suggested') {
    project = entry.suggestionId && getProject(entry.suggestionId);
  } else if (value.mode === 'existing') {
    project = value.projectId && getProject(value.projectId);
    if (!project) return { ok: false, message: 'Pick a project from the list first, or create a new one.' };
  } else if (value.mode === 'new') {
    const client = String(value.clientName || '').trim();
    const name = String(value.projectName || '').trim();
    if (!client || !name) return { ok: false, message: 'A new project needs both a client name and a project name.' };
    const existing = findByName(client, name);
    project = existing || createProject({ clientName: client, projectName: name, createdBy });
    created = !existing;
  }
  if (!project) return { ok: false, message: 'That choice is not available any more. Pick again.' };

  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve({ project, created });
  return { ok: true, project, created };
}

module.exports = { askProject, answerProject, PROMPT_MINUTES };
