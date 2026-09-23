const logger = require('../utils/logger');

// No Teams client offline, so the intended message is just described.
async function sendToUser(_adapter, userId, activity) {
  logger.info({ userId, activity }, 'MOCK: would send activity to user');
}

async function sendCard(_adapter, userId, card) {
  const title = (card.body || []).map((b) => b.text).filter(Boolean)[0] || 'card';
  console.log(`\n  [teams -> ${userId}] card: ${title}`);
  for (const block of card.body || []) {
    if (block.type === 'TextBlock' && block.text) console.log(`      ${block.text}`);
    if (block.type === 'FactSet') {
      for (const f of block.facts) console.log(`      ${f.title}: ${f.value}`);
    }
  }
  for (const a of card.actions || []) console.log(`      [${a.title}]`);
}

async function sendText(_adapter, userId, text) {
  console.log(`  [teams -> ${userId}] ${text}`);
}

async function sendDocument(_adapter, userId, { card, filePath, fileName }) {
  await sendCard(_adapter, userId, card);
  console.log(`      attachment: ${fileName} (${filePath})`);
}

class NoConversationError extends Error {}

module.exports = { sendToUser, sendCard, sendText, sendDocument, NoConversationError };
