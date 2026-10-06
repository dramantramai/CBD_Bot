const fs = require('fs');
const { TeamsActivityHandler, TurnContext, CardFactory } = require('botbuilder');
const logger = require('../utils/logger');
const { buildWelcomeCard } = require('./cards');
const { buildSignInCard, hasSignedIn, completeSignIn } = require('./sso');
const { saveReference } = require('../db/conversations');
const { settle } = require('../filter/uncertainPrompt');
const { listRecent } = require('../db/meetings');

class CbdBot extends TeamsActivityHandler {
  constructor() {
    super();

    // Every turn is a chance to capture the reference we need to DM this user
    // later, when their meeting ends and nobody is looking at Teams.
    this.onTurn(async (context, next) => {
      const userId = this.userIdOf(context);
      if (userId) saveReference(userId, TurnContext.getConversationReference(context.activity));
      await next();
    });

    this.onMembersAdded(async (context, next) => {
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
      if (value && value.action) {
        await this.handleCardAction(context, value);
      } else {
        await this.handleText(context);
      }
      await next();
    });
  }

  userIdOf(context) {
    const from = context.activity.from || {};
    return from.aadObjectId || from.id;
  }

  async handleCardAction(context, value) {
    const userId = this.userIdOf(context);

    if (value.action === 'signin') {
      await context.sendActivity({ attachments: [buildSignInCard()] });
      return;
    }

    if (value.action === 'confirmMeeting') {
      const wanted = value.answer === 'yes';
      const known = settle(value.meetingId, userId, wanted);
      await context.sendActivity(
        !known
          ? 'That prompt has already expired, so I skipped the meeting. Say ' +
              '"brief <meeting name>" if you still want a document for it.'
          : wanted
            ? "On it - I'll send the brief in a moment."
            : 'Skipped. I will not ask about that meeting again.'
      );
      return;
    }

    logger.warn({ value }, 'Unrecognised card action');
  }

  async handleText(context) {
    const text = (context.activity.text || '').trim().toLowerCase();
    const userId = this.userIdOf(context);

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
      await context.sendActivity({ attachments: [buildSignInCard()] });
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
      'I draft Client Brief Documents from client meeting transcripts, ' +
        'automatically after the meeting ends. Try "status", or "sign in" to ' +
        'let me reach transcripts from meetings a client hosted.'
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
      `No problem - **${fileName}** stays on the server and I won't send it.`
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
