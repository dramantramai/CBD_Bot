const crypto = require('crypto');
const { getDb } = require('./connection');

/**
 * "Verdant Kitchens" -> "VerdantKitchens". Words are joined with their first
 * letter capitalised and the rest left alone, so "AI newsletter" -> "AINewsletter".
 */
function slug(text) {
  return String(text || '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/** The project's name as people see it, and the folder it lives in: VerdantKitchens_Video. */
const projectLabel = (p) => `${slug(p.client_name)}_${slug(p.project_name)}`;

/** VerdantKitchens_Video_v2.docx */
const fileNameFor = (p, version) => `${projectLabel(p)}_v${version}.docx`;

const now = () => new Date().toISOString();

function createProject({ clientName, projectName, createdBy }) {
  const client = String(clientName || '').trim();
  const project = String(projectName || '').trim();
  if (!slug(client) || !slug(project)) throw new Error('A project needs a client name and a project name');
  if (findByName(client, project)) throw new Error(`A project called "${client} - ${project}" already exists`);

  const id = crypto.randomUUID();
  const at = now();
  getDb()
    .prepare(
      `INSERT INTO projects (id, client_name, project_name, created_by, last_activity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, client, project, createdBy || null, at, at, at);
  return getProject(id);
}

const getProject = (id) => getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) || null;

function findByName(clientName, projectName) {
  return (
    getDb()
      .prepare('SELECT * FROM projects WHERE client_name = ? COLLATE NOCASE AND project_name = ? COLLATE NOCASE')
      .get(String(clientName).trim(), String(projectName).trim()) || null
  );
}

const listProjects = () => getDb().prepare('SELECT * FROM projects ORDER BY last_activity DESC, rowid DESC').all();

/** Where the project's chat and folder are, once they exist. */
function setLocation(id, { chatId, folderBackend, folderOwner, folderName }) {
  getDb()
    .prepare(
      `UPDATE projects SET chat_id = COALESCE(?, chat_id), folder_backend = COALESCE(?, folder_backend),
         folder_owner = COALESCE(?, folder_owner), folder_name = COALESCE(?, folder_name), updated_at = ? WHERE id = ?`
    )
    .run(chatId ?? null, folderBackend ?? null, folderOwner ?? null, folderName ?? null, now(), id);
  return getProject(id);
}

/**
 * Records the next version. The number is taken from the record itself, in one
 * transaction, so two meetings finishing together cannot both become v2. A
 * previous version is never replaced.
 */
function addVersion(projectId, { backend, fileRef, fileOwner, uploadedEtag, sourceMeetingId, changeSummary, createdBy }) {
  const db = getDb();
  return db.transaction(() => {
    const project = getProject(projectId);
    if (!project) throw new Error(`No project ${projectId}`);
    const version = project.current_version + 1;
    const fileName = fileNameFor(project, version);
    const at = now();
    db.prepare(
      `INSERT INTO project_versions
         (id, project_id, version, file_name, backend, file_ref, file_owner, uploaded_etag, uploaded_at, source_meeting_id, change_summary, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(crypto.randomUUID(), projectId, version, fileName, backend, fileRef ?? null, fileOwner ?? null, uploadedEtag ?? null, at, sourceMeetingId ?? null, changeSummary ?? null, createdBy ?? null);
    db.prepare('UPDATE projects SET current_version = ?, last_activity = ?, updated_at = ? WHERE id = ?').run(version, at, at, projectId);
    return { version, fileName };
  })();
}

const nextFileName = (project) => fileNameFor(project, project.current_version + 1);

const getVersions = (projectId) =>
  getDb().prepare('SELECT * FROM project_versions WHERE project_id = ? ORDER BY version').all(projectId);

module.exports = { slug, projectLabel, fileNameFor, nextFileName, createProject, getProject, findByName, listProjects, setLocation, addVersion, getVersions };
