#!/usr/bin/env node
/**
 * Draft a meeting brief from a transcript file, with no Teams or Graph involved.
 *
 *   node scripts/meetingBrief.js meeting.vtt
 *   node scripts/meetingBrief.js notes.txt --title "Weekly delivery sync"
 *
 * Real as soon as an LLM key is in .env. Without one it prints the plain "drafted
 * without AI" result rather than guessing at the transcript.
 */
process.env.MOCK_MODE = process.env.MOCK_MODE || 'true';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const fs = require('fs');
const path = require('path');
const { parseVtt, cuesToText, cuesToTimedText } = require('../src/graph/vtt');
const { generateBrief } = require('../src/brief/generate');
const { formatBrief, splitMessages } = require('../src/brief/format');

async function main() {
  const [file] = process.argv.slice(2);
  if (!file || file.startsWith('--')) {
    console.error('Usage: node scripts/meetingBrief.js <transcript-file> [--title "..."]');
    process.exit(1);
  }
  const at = process.argv.indexOf('--title');
  const title = at > -1 ? process.argv[at + 1] : path.basename(file, path.extname(file));

  const raw = fs.readFileSync(file, 'utf8');
  const isVtt = /^﻿?WEBVTT/.test(raw) || file.toLowerCase().endsWith('.vtt');
  const cues = isVtt ? parseVtt(raw) : null;

  const brief = await generateBrief({
    transcript: isVtt ? cuesToText(cues) : raw.trim(),
    timedText: isVtt ? cuesToTimedText(cues) : undefined,
    meeting: { subject: title },
  });

  const messages = splitMessages(formatBrief(brief));
  console.log(`\n${messages.length} message${messages.length === 1 ? '' : 's'} would be sent:\n`);
  for (const m of messages) console.log(`${m}\n\n${'-'.repeat(60)}\n`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
