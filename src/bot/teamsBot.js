const { TeamsActivityHandler, TurnContext, CardFactory } = require('botbuilder');
const logger = require('../utils/logger');
const { buildWelcomeCard } = require('./cards');
const { buildSignInCard, handleTokenExchange, hasSignedIn } = require('./sso');
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

    if (text.includes('sign in') || text.includes('login')) {
      await context.sendActivity({ attachments: [buildSignInCard()] });
      return;
    }

    if (text.includes('status')) {
      const signedIn = hasSignedIn(userId);
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

  // Teams SSO handshake.
  async handleTeamsSigninTokenExchange(context) {
    const result = await handleTokenExchange(context);
    if (result.status === 200) {
      await context.sendActivity("You're all set. I'll take it from here.");
    }
    return result;
  }

  async handleTeamsSigninVerifyState(context) {
    await context.sendActivity("You're all set. I'll take it from here.");
  }
}

module.exports = { CbdBot };
