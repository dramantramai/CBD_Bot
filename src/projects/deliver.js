const fs = require('fs');
const { env } = require('../config/env');
const logger = require('../utils/logger');
const adapters = require('../config/adapters');
const projectsDb = require('../db/projects');
const { getStorage } = require('../storage');
const realChat = require('./graphChat');
const fakeChat = require('./fakeChat');

const unique = (list) => [...new Set(list.filter(Boolean))];
const isInternal = (email) => String(email || '').toLowerCase().endsWith(`@${env.TENANT_DOMAIN.toLowerCase()}`);
const say = (e) => (e && e.message) || String(e);

/**
 * Puts a finished client brief where the project lives: saves it as the next
 * version, makes sure the project's group chat exists, shares the folder with
 * the people in it and posts the file there. Everything but the save is
 * allowed to fail without losing the brief; what went wrong comes back as
 * `notes` for the organiser, and `delivered` says where the brief now is:
 *
 *   'chat'     posted in the project chat
 *   'personal' saved to the project folder; the link was sent to the organiser
 *   null       could not be saved at all; the caller sends the file itself
 *
 * Works through the project owner's own stored sign-in, so a later organiser
 * who is not in the chat still gets a saved version and the link. If the
 * owner's sign-in has expired, the version goes to the organiser's own drive.
 */
async function deliverToProject({ project, filePath, summary, meeting, attendeeId, botAdapter, deps = {} }) {
  const storage = deps.storage || getStorage();
  const chat = deps.chat || (env.MOCK_MODE ? fakeChat : realChat);
  const tokenFor = deps.tokenFor || ((userId) => adapters.auth.getDelegatedToken(userId));
  const proactive = deps.proactive || adapters.proactive;

  const notes = [];
  const organiser = meeting.dramantramUser || { id: attendeeId };
  const folder = `CBD Bot/${projectsDb.projectLabel(project)}`;
  const fileName = projectsDb.nextFileName(project);

  // 1. Save the version: the owner's drive first, then the organiser's own.
  const preferred = unique([project.folder_owner, project.created_by, attendeeId]);
  let saved;
  let savedBy;
  let lastError;
  for (const ownerId of preferred) {
    try {
      saved = await storage.saveFile({ ownerId, folder, fileName, content: fs.readFileSync(filePath) });
      savedBy = ownerId;
      break;
    } catch (err) {
      lastError = err;
      logger.warn({ projectId: project.id, ownerId, err: say(err) }, 'Could not save the version in this drive');
    }
  }
  if (!saved) return { delivered: null, notes: [`I could not save it to the project folder (${say(lastError)}).`] };
  if (savedBy !== preferred[0] && project.folder_owner) {
    notes.push('The project owner\'s sign-in has expired, so this version is in your own OneDrive. Ask them to say "sign in".');
  }

  const { version } = projectsDb.addVersion(project.id, {
    backend: storage.name,
    fileRef: saved.ref,
    fileOwner: savedBy,
    uploadedEtag: saved.etag,
    sourceMeetingId: meeting.id,
    createdBy: attendeeId,
  });
  let current = projectsDb.setLocation(project.id, { folderBackend: storage.name, folderOwner: project.folder_owner ? undefined : savedBy, folderName: folder });

  // 2. The project's chat: create it with the organiser's own sign-in if it does not exist yet.
  let chatId = current.chat_id;
  if (!chatId) {
    try {
      const token = await tokenFor(attendeeId);
      const emails = unique([...(meeting.attendees || []).map((a) => a.email).filter(isInternal), organiser.email]);
      const ids = unique([await chat.selfId(token)]);
      for (const email of emails) {
        try {
          ids.push(await chat.lookupUserId(token, email));
        } catch (err) {
          logger.warn({ email, err: say(err) }, 'Could not look up a chat member');
        }
      }
      const memberIds = unique(ids);
      if (memberIds.length < 2) {
        notes.push('Only you were in that meeting, so there is nobody to make a group chat with. Add a colleague to the meeting next time, or create the chat by hand and add me.');
      } else {
        chatId = await chat.createChat(token, { topic: projectsDb.projectLabel(project), memberIds, appCatalogId: env.TEAMS_CATALOG_APP_ID });
        current = projectsDb.setLocation(project.id, { chatId });
      }
    } catch (err) {
      notes.push(`I could not create the project chat (${say(err)}).`);
      logger.error({ projectId: project.id, err: say(err) }, 'Project chat could not be created');
    }
  }

  // 3. Everyone in the chat, and the organiser, can open and edit the folder.
  let memberMails = [];
  if (chatId) {
    for (const userId of unique([attendeeId, savedBy])) {
      try {
        memberMails = await chat.memberEmails(await tokenFor(userId), chatId);
        break;
      } catch (err) {
        logger.warn({ chatId, err: say(err) }, 'Could not list the chat members');
      }
    }
  }
  const shareWith = unique([...memberMails, organiser.email]);
  try {
    await storage.shareFolder({ ownerId: savedBy, folder, emails: shareWith });
  } catch (err) {
    notes.push('I saved it but could not share the folder, so some people may not be able to open it.');
    logger.error({ projectId: project.id, err: say(err) }, 'Sharing the project folder failed');
  }

  // 4. Post it. The chat is internal only; a person outside it gets the link in their own chat.
  const label = `${project.client_name} - ${project.project_name}`;
  const message = `**Client brief for ${label}, v${version}**\n\n[${fileName}](${saved.webUrl})\n\n${summary}`;
  let posted = false;
  if (chatId) {
    try {
      await proactive.sendToChat(botAdapter, attendeeId, chatId, { text: message });
      posted = true;
    } catch (err) {
      notes.push(`I could not post in the project chat (${say(err)}).`);
      logger.error({ chatId, err: say(err) }, 'Posting in the project chat failed');
    }
  }
  const organiserInChat = posted && (memberMails.length === 0 || memberMails.map((m) => m.toLowerCase()).includes(String(organiser.email || '').toLowerCase()));
  if (!posted || !organiserInChat) {
    await proactive.sendText(botAdapter, attendeeId, `${message}${posted ? '\n\nYou are not in the project chat, so here is the link.' : ''}`);
  }

  return { delivered: posted ? 'chat' : 'personal', chatId, version, fileName, webUrl: saved.webUrl, notes };
}

module.exports = { deliverToProject };
