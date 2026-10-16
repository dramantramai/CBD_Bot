const logger = require('../utils/logger');
const projectsDb = require('../db/projects');
const { getStorage } = require('../storage');
const { readCbd, TemplateLayoutError } = require('../docgen/readBack');
const { buildBaselineCard } = require('../bot/cards');

/**
 * Which file a new version starts from (blueprint 6.5). The current file may have been edited since
 * the bot saved it, or edited offline and emailed back, so the bot never assumes: it says what it
 * found and asks, every time, whether that is the file to build on.
 */

const PROMPT_MINUTES = 30;
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/** What is known about the project's current file: is it there, and has anyone changed it since the bot saved it. */
async function describeBaseline(project, { storage = getStorage() } = {}) {
  const row = projectsDb.getVersions(project.id).at(-1);
  if (!row) return { problem: 'no version has been saved yet' };
  const base = { version: row.version, fileName: row.file_name, row };
  try {
    const info = await storage.fileInfo({ ownerId: row.file_owner, ref: row.file_ref });
    const edited = Boolean(row.uploaded_etag) && info.etag !== row.uploaded_etag;
    return { ...base, edited, lastModified: info.lastModified, lastModifiedBy: info.lastModifiedBy };
  } catch (err) {
    const reason = err.status === 404 ? 'it was moved or deleted' : err.status === 401 || err.status === 403 ? 'I no longer have access to it' : 'it could not be reached';
    return { ...base, problem: reason };
  }
}

/** The one line the organiser is asked about. */
function questionFor(d) {
  if (d.problem) {
    return `I cannot open **v${d.version}** (${d.problem}). Drop the previous version's .docx here and I will build on that, or start fresh from this meeting alone.`;
  }
  return d.edited
    ? `Using **v${d.version}** (${d.fileName}), last edited ${day(d.lastModified)}${d.lastModifiedBy ? ` by ${d.lastModifiedBy}` : ''}. Is that right?`
    : `**v${d.version}** (${d.fileName}), generated ${day(d.row.uploaded_at)}, not edited since. Is that right?`;
}

/** What the bot wrote in that version, as values; null for a version saved before this was kept. */
function originalOf(row) {
  try {
    return row && row.snapshot ? JSON.parse(row.snapshot) : null;
  } catch {
    return null;
  }
}

// ── waiting for the answer, and for a file ───────────────────────────────────

const questions = new Map(); // `${userId}::${meetingId}` -> { resolve, timer }
const uploads = new Map(); // userId -> { resolve, timer }
const key = (meetingId, userId) => `${userId}::${meetingId}`;

function ask({ meeting, userId, description, send, timeoutMs }) {
  const id = key(meeting.id, userId);
  if (questions.has(id)) return questions.get(id).promise;
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  const timer = setTimeout(() => {
    questions.delete(id);
    resolve('timeout');
  }, timeoutMs ?? PROMPT_MINUTES * 60 * 1000);
  if (timer.unref) timer.unref();
  questions.set(id, { promise, resolve, timer });
  send(buildBaselineCard({ meetingId: meeting.id, title: meeting.subject, question: questionFor(description), canUse: !description.problem }));
  return promise;
}

/** A button on the baseline card. */
function answer({ meetingId, userId, choice }) {
  const entry = questions.get(key(meetingId, userId));
  if (!entry || !['use', 'upload', 'fresh'].includes(choice)) return false;
  clearTimeout(entry.timer);
  questions.delete(key(meetingId, userId));
  entry.resolve(choice);
  return true;
}

function waitForUpload(userId, timeoutMs) {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  const timer = setTimeout(() => {
    uploads.delete(userId);
    resolve(null);
  }, timeoutMs ?? PROMPT_MINUTES * 60 * 1000);
  if (timer.unref) timer.unref();
  uploads.set(userId, { resolve, timer });
  return promise;
}

const isWaitingForUpload = (userId) => uploads.has(userId);

/** A .docx was dropped in the chat while a baseline was awaited. */
function receiveUpload(userId, file) {
  const entry = uploads.get(userId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  uploads.delete(userId);
  entry.resolve(file);
  return true;
}

// ── the whole decision ───────────────────────────────────────────────────────

/**
 * Settles which file the new version builds on. Returns
 *   { mode: 'use', cbd, flagged, version, source: 'stored' | 'uploaded', warning? }
 *   { mode: 'fresh' }       build from this meeting alone
 *   { mode: 'cancelled' }   nobody answered; nothing is made, so nothing is silently wrong
 * `deps` lets a test stand in for the people and the drive.
 */
async function chooseBaseline({ project, meeting, attendeeId, send, sendText, deps = {} }) {
  const storage = deps.storage || getStorage();
  const askFn = deps.ask || ((description) => ask({ meeting, userId: attendeeId, description, send }));
  const upload = deps.waitForUpload || (() => waitForUpload(attendeeId));

  let description = await describeBaseline(project, { storage });
  for (;;) {
    const choice = await askFn(description);
    if (choice === 'fresh') return { mode: 'fresh' };
    if (choice === 'timeout') return { mode: 'cancelled' };

    if (choice === 'use') {
      try {
        const buffer = await storage.readFile({ ownerId: description.row.file_owner, ref: description.row.file_ref });
        return { mode: 'use', source: 'stored', version: description.version, original: originalOf(description.row), ...readCbd(buffer) };
      } catch (err) {
        logger.warn({ projectId: project.id, err: err.message }, 'The stored file could not be used as a baseline');
        description = { ...description, problem: err instanceof TemplateLayoutError ? 'it no longer follows the CBD layout' : 'it could not be read' };
        continue;
      }
    }

    // choice === 'upload'
    await sendText('Drop the previous version\'s .docx here and I will build on that.');
    const file = await upload();
    if (!file) return { mode: 'cancelled' };
    try {
      const read = readCbd(file.buffer);
      const said = read.header && read.header.version;
      const expected = description.version;
      const warning =
        said === undefined || said === null
          ? `${file.name} has no version line, so I cannot tell which version it is. I have used it as you asked.`
          : said !== expected
            ? `${file.name} says v${said}, and the last version I saved is v${expected}. I have used it as you asked; changes made in other versions may be missing.`
            : undefined;
      // The original is known only when the file says it is the version the bot saved.
      const original = said === expected ? originalOf(description.row) : null;
      return { mode: 'use', source: 'uploaded', version: expected, warning, original, ...read };
    } catch (err) {
      const why = err instanceof TemplateLayoutError ? 'it no longer follows the CBD layout, so I cannot read it reliably. Send a clean copy' : `I could not read it (${err.message})`;
      await sendText(`I cannot use ${file.name}: ${why}, or start fresh.`);
      description = { ...description, problem: 'the file you sent could not be used' };
    }
  }
}

module.exports = { chooseBaseline, describeBaseline, questionFor, ask, answer, waitForUpload, receiveUpload, isWaitingForUpload, PROMPT_MINUTES };
