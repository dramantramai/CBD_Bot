const { env } = require('../config/env');
const auth = require('../graph/auth');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const enc = (path) => path.split('/').map(encodeURIComponent).join('/');

/**
 * Project files through a Microsoft Graph drive. OneDrive and SharePoint are
 * the same API at different roots, so one implementation serves both:
 *
 *   - OneDrive: the project owner's own drive, with the owner's delegated sign-in.
 *   - SharePoint: one site's document library, with the app's own permission.
 *
 * Every method takes the owner's id; SharePoint ignores it.
 */
function makeDriveStorage({ name, driveBase, getToken }) {
  async function call(ownerId, method, path, { body, headers, raw } = {}) {
    const token = await getToken(ownerId);
    const res = await fetch(`${GRAPH}${driveBase}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...headers }, body });
    if (!res.ok) {
      const err = new Error(`${name} ${method} ${path} failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (raw) return Buffer.from(await res.arrayBuffer());
    return res.status === 204 ? {} : res.json();
  }

  return {
    name,

    /** Saves a new file. Never replaces one: a name that already exists fails (a version is never overwritten). */
    async saveFile({ ownerId, folder, fileName, content }) {
      const item = await call(ownerId, 'PUT', `/root:/${enc(`${folder}/${fileName}`)}:/content?@microsoft.graph.conflictBehavior=fail`, {
        body: content,
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      });
      return { ref: item.id, etag: item.eTag, webUrl: item.webUrl };
    },

    readFile: ({ ownerId, ref }) => call(ownerId, 'GET', `/items/${ref}/content`, { raw: true }),

    /** The etag the bot saved is compared with this to see whether a person edited the file since. */
    async fileInfo({ ownerId, ref }) {
      const item = await call(ownerId, 'GET', `/items/${ref}?$select=eTag,lastModifiedDateTime,lastModifiedBy`);
      return {
        etag: item.eTag,
        lastModified: item.lastModifiedDateTime,
        lastModifiedBy: item.lastModifiedBy && item.lastModifiedBy.user && item.lastModifiedBy.user.displayName,
      };
    },

    /** Gives the people in the project chat edit access to the whole folder, without sending them an email. */
    async shareFolder({ ownerId, folder, emails }) {
      if (!emails.length) return;
      const item = await call(ownerId, 'GET', `/root:/${enc(folder)}`);
      await call(ownerId, 'POST', `/items/${item.id}/invite`, {
        body: JSON.stringify({ recipients: emails.map((email) => ({ email })), requireSignIn: true, sendInvitation: false, roles: ['write'] }),
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

const oneDrive = () => makeDriveStorage({ name: 'onedrive', driveBase: '/me/drive', getToken: (ownerId) => auth.getDelegatedToken(ownerId) });

const sharePoint = () => {
  if (!env.SHAREPOINT_SITE_ID) throw new Error('PROJECT_STORAGE=sharepoint needs SHAREPOINT_SITE_ID');
  return makeDriveStorage({ name: 'sharepoint', driveBase: `/sites/${env.SHAREPOINT_SITE_ID}/drive`, getToken: () => auth.getAppToken() });
};

module.exports = { makeDriveStorage, oneDrive, sharePoint };
