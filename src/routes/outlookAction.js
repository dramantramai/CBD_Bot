const express = require('express');

/**
 * Placeholder. The Resource Request Bot shares this VM and will mount its
 * Outlook actionable-message endpoint here. Nothing in the CBD Bot uses it.
 */
function outlookActionRouter() {
  const router = express.Router();
  router.post('/outlook-action', (_req, res) =>
    res.status(501).json({ error: 'Resource Request Bot is not deployed here yet.' })
  );
  return router;
}

module.exports = { outlookActionRouter };
