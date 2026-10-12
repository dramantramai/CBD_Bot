#!/usr/bin/env node
/**
 * Draft a CBD from a transcript file, with no Teams or Graph involved.
 *
 *   node scripts/brief.js meeting.vtt
 *   node scripts/brief.js notes.txt --title "Acme x Dramantram - Kickoff"
 *   node scripts/brief.js meeting.vtt --provider groq --print-prompt
 *
 * Extraction is real as soon as an LLM key is in .env; without one it falls back
 * to the offline heuristic extractor and says so.
 */
process.env.MOCK_MODE = process.env.MOCK_MODE || 'true';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const fs = require('fs');
const path = require('path');

const { env } = require('../src/config/env');
const { toTranscriptText } = require('../src/graph/vtt');
const { extractCBD, CHAIN } = require('../src/llm/extractCBD');
const { fillTemplate } = require('../src/docgen/fillTemplate');
const { buildPrompt } = require('../src/llm/prompt');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function usage() {
  console.log(`
${bold('Draft a Client Brief Document from a transcript.')}

  node scripts/brief.js <transcript-file> [options]

${bold('Options')}
  --title    <text>   Meeting title. Best source of the client name.
  --owner    <name>   Dramantram project owner        (default: from .env or "")
  --email    <email>  Project owner email
  --phone    <phone>  Project owner phone
  --date     <iso>    Meeting start, e.g. 2026-09-22T10:00:00Z
  --attendee <n:e>    "Name:email@client.com". Repeatable via commas.
  --provider <name>   Force one of: ${CHAIN.map((p) => p.name).join(', ')}, mock
  --out      <path>   Output .docx path
  --print-prompt      Show the prompt that would be sent, then exit
  --json              Also write the extracted JSON next to the .docx

${bold('Accepts')} .vtt (Teams transcript) or .txt (plain notes / pasted transcript).
`);
}

function loadTranscript(file) {
  const raw = fs.readFileSync(file, 'utf8');
  // A .vtt needs its cues and timestamps stripped; anything else is used as-is.
  const isVtt = /^﻿?WEBVTT/.test(raw) || file.toLowerCase().endsWith('.vtt');
  return isVtt ? toTranscriptText(raw) : raw.trim();
}

function buildMeeting(args, file) {
  const attendees = String(args.attendee || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [displayName, email] = entry.split(':').map((s) => s && s.trim());
      return { displayName: displayName || email, email: email || null, role: 'attendee' };
    });

  const owner = {
    id: 'local-cli-user',
    displayName: args.owner || process.env.DEFAULT_OWNER_NAME || '',
    email: args.email || process.env.DEFAULT_OWNER_EMAIL || '',
    phone: args.phone || process.env.DEFAULT_OWNER_PHONE || '',
  };
  if (owner.displayName && !attendees.some((a) => a.email === owner.email)) {
    attendees.push({ ...owner, role: 'attendee' });
  }

  const start = args.date || new Date().toISOString();
  return {
    id: `local-${path.basename(file)}`,
    subject: args.title || path.basename(file, path.extname(file)),
    startDateTime: start,
    endDateTime: new Date(new Date(start).getTime() + 30 * 60000).toISOString(),
    hostedBy: 'external',
    dramantramUser: owner,
    attendees,
  };
}

function resolveChain(name) {
  if (!name) return undefined; // let extractCBD decide from configured keys
  if (name === 'mock') return [];
  const provider = CHAIN.find((p) => p.name === name);
  if (!provider) {
    console.error(red(`Unknown provider "${name}". Try: ${CHAIN.map((p) => p.name).join(', ')}, mock`));
    process.exit(1);
  }
  if (!provider.isConfigured()) {
    console.error(
      red(`${name} has no API key set. Add ${name.toUpperCase()}_API_KEY to .env.`)
    );
    process.exit(1);
  }
  return [provider];
}

function report(cbd, elapsedMs) {
  const usedMock = cbd._provider === 'mock';
  console.log(
    '\n' +
      bold('Extracted by: ') +
      (usedMock
        ? yellow('offline heuristic extractor')
        : green(cbd._provider + (cbd._model ? ` (${cbd._model})` : ''))) +
      dim(`  ·  ${elapsedMs} ms  ·  average confidence ${cbd.confidenceAvg}/5`)
  );
  const failures = cbd._providerErrors || [];
  if (usedMock) {
    console.log(
      yellow(
        failures.length
          ? '  Every configured provider failed, so this fell back to the ' +
              'development extractor. The errors are below.'
          : '  No LLM key configured, so this is the development extractor. ' +
              'Add GEMINI_API_KEY to .env for real extraction.'
      )
    );
  }
  for (const e of failures) console.log(red(`  provider failed: ${e}`));

  console.log('\n' + bold('Fields') + dim('  [confidence]'));
  const fields = [
    'projectName', 'launchDate', 'projectOwnerName', 'projectOwnerEmail',
    'spoc', 'escalationPoint', 'businessObjective', 'solutionScope',
    'keyMessage', 'callToAction', 'audienceProfile', 'otherMentions',
  ];
  for (const f of fields) {
    const score = cbd.confidence[f];
    const flag = score < 3 ? red(`[${score}]`) : dim(`[${score}]`);
    const value = String(cbd[f] || '').replace(/\n/g, ' | ');
    console.log(`  ${f.padEnd(18)} ${flag} ${value.slice(0, 90) || dim('(empty)')}`);
  }

  console.log('\n' + bold('Checkboxes'));
  const boxes = Object.entries(cbd.checkboxes);
  if (!boxes.length) console.log(dim('  none selected'));
  for (const [group, labels] of boxes) {
    console.log(`  ${group.padEnd(18)} ${labels.join(', ')}`);
  }

  if (cbd.needsConfirmation.length) {
    console.log(
      '\n' +
        red(`${cbd.needsConfirmation.length} field(s) need review: `) +
        cbd.needsConfirmation.join(', ')
    );
  } else {
    console.log('\n' + green('Every field was supported by the transcript.'));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];

  if (!file || args.help) {
    usage();
    process.exit(file ? 0 : 1);
  }
  if (!fs.existsSync(file)) {
    console.error(red(`No such file: ${file}`));
    process.exit(1);
  }

  const transcript = loadTranscript(file);
  const meeting = buildMeeting(args, file);

  if (!transcript) {
    console.error(red('That transcript is empty.'));
    process.exit(1);
  }

  if (args['print-prompt']) {
    const { system, user } = buildPrompt({ transcript, meeting });
    console.log(bold('--- system ---\n') + system);
    console.log(bold('\n--- user ---\n') + user);
    return;
  }

  console.log(
    dim(
      `\n${path.basename(file)}  ·  ${transcript.length} chars  ·  ` +
        `"${meeting.subject}"`
    )
  );

  const started = Date.now();
  const cbd = await extractCBD(
    { transcript, meeting },
    { chain: resolveChain(args.provider) }
  );
  const elapsed = Date.now() - started;

  report(cbd, elapsed);

  const outPath = fillTemplate(cbd, {
    outputPath: args.out,
    outputDir: env.OUTPUT_DIR,
  });
  console.log('\n' + bold('Document: ') + outPath);

  if (args.json) {
    const jsonPath = outPath.replace(/\.docx$/, '.json');
    fs.writeFileSync(jsonPath, JSON.stringify(cbd, null, 2));
    console.log(bold('JSON:     ') + jsonPath);
  }

  console.log(dim(`\nOpen it with:  open "${outPath}"\n`));
}

main().catch((err) => {
  console.error(red('\n' + err.message));
  if (process.env.LOG_LEVEL === 'debug') console.error(err.stack);
  process.exit(1);
});
