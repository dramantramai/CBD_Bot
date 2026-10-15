const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { TeamsActivityHandler, TurnContext, CardFactory } = require('botbuilder');
const logger = require('../utils/logger');
const { briefFromText } = require('../pipeline');
const { parseVtt, cuesToText, cuesToTimedText } = require('../graph/vtt');

const FILE_DOWNLOAD = 'application/vnd.microsoft.teams.file.download.info';

// ponytail: both are in memory, so a restart forgets them and the person just
// asks again. A table would survive restarts if that ever proves annoying.
const awaiting = new Map(); // userId -> { kind, at }: said "client brief" or "meeting brief", transcript to follow
const heldFiles = new Map(); // token -> a dropped file waiting on "which one do you want?"
const HOLD_MS = 10 * 60 * 1000;
const MIN_NOTES_CHARS = 200;
const KINDS = { client: 'client brief', meeting: 'meeting brief' };
const isFresh = (at) => at > Date.now() - HOLD_MS;
const { buildWelcomeCard, buildChooseOutputCard } = require('./cards');
const { sendSignInPrompt, hasSignedIn, completeSignIn } = require('./sso');
const { saveReference } = require('../db/conversations');
const { env } = require('../config/env');
const { settle } = require('../filter/uncertainPrompt');
const { listRecent, briefFiles } = require('../db/meetings');
const { fileConsentAttachment } = require('./proactive');

function askForTranscript(kind) {
  const why =
    kind === 'client'
      ? 'Use this for meetings a client hosted: their transcripts live on their tenant, so I cannot fetch those myself.'
      : 'Use this for any meeting I did not pick up myself, including a direct call.';
  return (
    `Send me the transcript and I will draft the ${KINDS[kind]} - upload the **.vtt** from ` +
    `the meeting, or just paste the notes in your next message.\n\n${why}`
  );
}

class CbdBot extends TeamsActivityHandler {
  constructor() {
    super();

    // Every turn is a chance to capture the reference we need to DM this user
    // later, when their meeting ends and nobody is looking at Teams.
    this.onTurn(async (context, next) => {
      this.rememberReference(context);
      await next();
    });

    this.onMembersAdded(async (context, next) => {
      if (context.activity.conversation?.conversationType !== 'personal') return next();
      for (const member of context.activity.membersAdded) {
        if (member.id === context.activity.recipient.id) continue;
        await context.sendActivity({
          attachments: [
            CardFactory.adaptiveCard(
              buildWelcomeCard({ userName: member.name || 'there' })
            ),
          ],
        });
      }
      await next();
    });

    this.onMessage(async (context, next) => {
      const value = context.activity.value;
      const file = (context.activity.attachments || []).find(
        (a) => a.contentType === FILE_DOWNLOAD
      );

      if (file) {
        await this.handleUploadedTranscript(context, file);
      } else if (value && value.action) {
        await this.handleCardAction(context, value);
      } else {
        await this.handleText(context);
      }
      await next();
    });
  }

  /** Only a personal chat is where a user's own briefs go; a group chat must never replace it. */
  rememberReference(context) {
    const userId = this.userIdOf(context);
    if (userId && context.activity.conversation?.conversationType === 'personal') {
      saveReference(userId, TurnContext.getConversationReference(context.activity));
    }
  }

  userIdOf(context) {
    const from = context.activity.from || {};
    return from.aadObjectId || from.id;
  }

  /**
   * A transcript the user handed over, for a meeting this tenant cannot fetch
   * - which is every meeting a client hosted. The download URL Teams provides
   * is already authorised, so it is fetched as-is.
   *
   * If they already said which output they want, it is made straight away;
   * otherwise the file is held for a few minutes and they are asked.
   */
  async handleUploadedTranscript(context, file) {
    const userId = this.userIdOf(context);
    const name = file.name || 'transcript';
    const url = file.content && file.content.downloadUrl;

    if (!url) {
      await context.sendActivity("I couldn't read that file - Teams sent no download link.");
      return;
    }

    if (!/\.(vtt|txt|md)$/i.test(name)) {
      await context.sendActivity(
        `I can read **.vtt** (the Teams transcript export) and plain **.txt**. ` +
          `**${name}** is neither - export the transcript as .vtt, or paste the ` +
          `notes after saying "client brief" or "meeting brief".`
      );
      return;
    }

    await context.sendActivity(`Reading **${name}**...`);

    let parsed;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download returned HTTP ${res.status}`);
      const raw = await res.text();
      // A .vtt is timestamps and cue markup; keep the times for the meeting brief.
      if (/\.vtt$/i.test(name)) {
        const cues = parseVtt(raw);
        parsed = { text: cuesToText(cues), timedText: cuesToTimedText(cues) };
      } else {
        parsed = { text: raw };
      }
    } catch (err) {
      logger.error({ err: err.message, name }, 'Reading an uploaded transcript failed');
      await context.sendActivity(`I couldn't read **${name}**: ${err.message}. Try again, or paste the notes instead.`);
      return;
    }

    const title = path.basename(name, path.extname(name));
    const pending = awaiting.get(userId);
    if (pending && isFresh(pending.at)) {
      awaiting.delete(userId);
      await this.makeBrief(context, { kind: pending.kind, ...parsed, title, source: 'uploaded' });
      return;
    }

    const token = randomUUID();
    heldFiles.set(token, { userId, ...parsed, title, at: Date.now() });
    await context.sendActivity({
      attachments: [CardFactory.adaptiveCard(buildChooseOutputCard({ detail: `I have read ${name}.`, token }))],
    });
  }

  /** Makes the requested brief from a supplied transcript, and says plainly if it cannot. */
  async makeBrief(context, args) {
    try {
      await briefFromText({ ...args, userId: this.userIdOf(context), botAdapter: context.adapter });
    } catch (err) {
      logger.error({ err: err.message, kind: args.kind }, 'Briefing a supplied transcript failed');
      await context.sendActivity(
        `I couldn't draft that ${KINDS[args.kind]}: ${err.message}. Try again, or paste the notes instead.`
      );
    }
  }

  /** The answer to "which one do you want?", from a dropped file or from a bare "brief". */
  async handleChooseOutput(context, { answer, token }) {
    const userId = this.userIdOf(context);
    if (token) {
      const held = heldFiles.get(token);
      heldFiles.delete(token);
      if (answer === 'cancel') {
        await context.sendActivity('Cancelled - nothing was generated.');
      } else if (!KINDS[answer]) {
        logger.warn({ answer }, 'Unrecognised output choice');
      } else if (!held || held.userId !== userId || !isFresh(held.at)) {
        await context.sendActivity(
          'I am no longer holding that file. Drop it again, or say "client brief" or "meeting brief" first.'
        );
      } else {
        await context.sendActivity(`Working on the ${KINDS[answer]}...`);
        await this.makeBrief(context, { kind: answer, text: held.text, timedText: held.timedText, title: held.title, source: 'uploaded' });
      }
      return;
    }

    if (answer === 'cancel') {
      await context.sendActivity('Cancelled.');
    } else if (KINDS[answer]) {
      awaiting.set(userId, { kind: answer, at: Date.now() });
      await context.sendActivity(askForTranscript(answer));
    }
  }

  async handleCardAction(context, value) {
    const userId = this.userIdOf(context);

    if (value.action === 'signin') {
      await sendSignInPrompt(context);
      return;
    }

    if (value.action === 'chooseOutput') {
      await this.handleChooseOutput(context, value);
      return;
    }

    if (value.action === 'confirmMeeting') {
      const known = settle(value.meetingId, userId, value.answer);
      const wanted = value.answer !== 'no';
      await context.sendActivity(
        !known
          ? 'That prompt has already expired, so I skipped the meeting. Say "client brief" or ' +
              '"meeting brief" and send me the transcript if you still want one.'
          : wanted
            ? `On it - I'll send ${KINDS[value.answer] ? `the ${KINDS[value.answer]}` : 'it'} in a moment.`
            : 'Skipped - nothing was read or generated. I will not ask about that meeting again. ' +
              'Say "client brief" or "meeting brief" and send me the transcript if you change your mind.'
      );
      return;
    }

    logger.warn({ value }, 'Unrecognised card action');
  }

  /** Offers the newest client brief still on the server again. Teams' file offer only works in a personal chat. */
  async resendLastBrief(context, userId) {
    if (context.activity.conversation?.conversationType !== 'personal') {
      await context.sendActivity('Ask me for that in our personal chat: Teams can only hand a file over there.');
      return;
    }
    const latest = briefFiles(userId).find((r) => fs.existsSync(r.cbd_file_path));
    if (!latest) {
      await context.sendActivity(
        `I have no client brief of yours on the server. I keep them for ${env.TRANSCRIPT_RETENTION_DAYS} days, then delete them.`
      );
      return;
    }
    const fileName = path.basename(latest.cbd_file_path);
    await context.sendActivity({
      text: `Your latest client brief is **${latest.meeting_title || fileName}**, made ${latest.created_at.slice(0, 10)}. Accept it below to have it sent again.`,
      attachments: [fileConsentAttachment({ filePath: latest.cbd_file_path, fileName })],
    });
  }

  async handleText(context) {
    const raw = (context.activity.text || '').trim();
    const text = raw.toLowerCase();
    const userId = this.userIdOf(context);

    // The message after "client brief" or "meeting brief" is the notes themselves,
    // so it cannot be matched against commands - "status" could appear in them.
    const pending = awaiting.get(userId);
    if (pending && isFresh(pending.at)) {
      awaiting.delete(userId);
      if (raw.length < MIN_NOTES_CHARS) {
        await context.sendActivity(
          `That is only ${raw.length} characters - too little to draft a ${KINDS[pending.kind]} from. ` +
            `Say "${KINDS[pending.kind]}" and paste the full notes, or upload the .vtt.`
        );
        return;
      }
      await context.sendActivity('Working through those notes...');
      await this.makeBrief(context, { kind: pending.kind, text: raw, title: 'Notes', source: 'pasted' });
      return;
    }

    for (const [kind, command] of Object.entries(KINDS)) {
      if (text === command || text.startsWith(`${command} `)) {
        awaiting.set(userId, { kind, at: Date.now() });
        await context.sendActivity(askForTranscript(kind));
        return;
      }
    }

    if (text === 'last client brief') {
      await this.resendLastBrief(context, userId);
      return;
    }

    // A bare "brief" is ambiguous - there are two kinds - so ask which.
    if (text === 'brief') {
      await context.sendActivity({
        attachments: [
          CardFactory.adaptiveCard(
            buildChooseOutputCard({ detail: 'Choose one, then send me the transcript.', token: '' })
          ),
        ],
      });
      return;
    }

    // Teams normally intercepts the magic code and sends it as a
    // signin/verifyState invoke, but it can only do that while it has a
    // pending card session. If that correlation is lost the code arrives as
    // an ordinary message instead, and without this it would fall through to
    // the help text with the sign-in left half-finished.
    if (/^\d{6}$/.test(text)) {
      await this.finishSignIn(context, text);
      return;
    }

    if (text.includes('sign in') || text.includes('login')) {
      await sendSignInPrompt(context);
      return;
    }

    if (text.includes('status')) {
      const signedIn = await hasSignedIn(context);
      const recent = listRecent(5).filter((r) => r.user_id === userId);
      await context.sendActivity(
        [
          signedIn
            ? 'You are signed in, so I can reach client-hosted transcripts.'
            : 'You have not signed in yet, so I can only read Dramantram-hosted meetings. Say "sign in".',
          recent.length
            ? '\n\nRecent meetings:\n' +
              recent
                .map((r) => `- ${r.meeting_title}: ${r.filter_result}`)
                .join('\n')
            : '\n\nI have not processed any of your meetings yet.',
        ].join('')
      );
      return;
    }

    await context.sendActivity(
      'I turn meeting transcripts into two things: a **client brief** (the Client Brief ' +
        'Document) for client meetings, and a **meeting brief** (decisions, action items, ' +
        'open questions) for internal ones. After a meeting you organised I ask first, and ' +
        'read nothing until you say yes.\n\n' +
        'For a meeting the client hosted, or one I did not pick up, say **"client brief"** or ' +
        '**"meeting brief"** and send me the transcript, or just drop a .vtt here and I will ' +
        'ask which you want.\n\n' +
        'Say **"last client brief"** to have the newest one sent again (I keep them for ' +
        `${env.TRANSCRIPT_RETENTION_DAYS} days), or **"status"** to see what I have processed.`
    );
  }

  // Teams sends this when its own SSO handshake fails (before falling back to
  // the interactive OAuthCard popup) - the base SDK has no handler for it and
  // 501s, silently discarding the failure code/message we need to diagnose it.
  async onInvokeActivity(context) {
    if (context.activity.name === 'signin/failure') {
      logger.error({ value: context.activity.value }, 'Teams SSO signin/failure');
      return { status: 200 };
    }
    return super.onInvokeActivity(context);
  }

  /**
   * The user accepted the document. Teams hands back a short-lived upload URL
   * pointing into their own OneDrive; writing the bytes there is what actually
   * puts the file in the chat.
   */
  async handleTeamsFileConsentAccept(context, response) {
    const { filePath, fileName } = response.context || {};
    const upload = response.uploadInfo || {};

    try {
      const data = fs.readFileSync(filePath);
      const res = await fetch(upload.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(data.length),
          'Content-Range': `bytes 0-${data.length - 1}/${data.length}`,
        },
        body: data,
      });
      if (!res.ok) throw new Error(`upload returned HTTP ${res.status}`);

      await context.sendActivity({
        attachments: [
          {
            contentType: 'application/vnd.microsoft.teams.card.file.info',
            contentUrl: upload.contentUrl,
            name: upload.name,
            content: { uniqueId: upload.uniqueId, fileType: upload.fileType },
          },
        ],
      });
      logger.info({ fileName }, 'Document uploaded to the user');
    } catch (err) {
      logger.error({ fileName, filePath, err: err.message }, 'Document upload failed');
      await context.sendActivity(
        `I couldn't upload **${fileName}**. ${
          // Briefs are purged on a retention schedule, so an old card can
          // outlive the file it points at.
          err.code === 'ENOENT'
            ? 'It has already been cleared from the server.'
            : 'Say "sign in" if the problem persists and I will try again.'
        }`
      );
    }
  }

  async handleTeamsFileConsentDecline(context, response) {
    const { fileName } = response.context || {};
    await context.sendActivity(
      `No problem - I won't send it. **${fileName}** stays on the server for ${env.TRANSCRIPT_RETENTION_DAYS} days in case you need it, then it is deleted.`
    );
  }

  // Teams posts the magic code back here once the popup closes.
  async handleTeamsSigninVerifyState(context) {
    const value = context.activity.value || {};
    await this.finishSignIn(context, value.state);
  }

  async finishSignIn(context, magicCode) {
    const ok = await completeSignIn(context, magicCode);
    await context.sendActivity(
      ok
        ? "You're all set. I'll take it from here."
        : 'That sign-in did not complete. Say "sign in" to start again.'
    );
  }
}

module.exports = { CbdBot };
