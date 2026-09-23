/**
 * Not in use. The bot processes each meeting inline in routes/webhook.js, which
 * keeps the deployment to one process and inside the free tier.
 *
 * A real queue only becomes worth its Redis instance if meetings start arriving
 * faster than they can be processed, or if losing an in-flight meeting to a
 * restart becomes a real problem. At that point: npm i bullmq ioredis, move the
 * processMeeting call in routes/webhook.js into a job, and run this worker
 * alongside the server under PM2.
 */
module.exports = {};
