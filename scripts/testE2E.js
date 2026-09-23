#!/usr/bin/env node
/**
 * Runs the whole pipeline offline against a fixture and writes a real .docx.
 *
 *   node scripts/testE2E.js                  # every fixture
 *   node scripts/testE2E.js client-meeting   # one fixture
 *
 * Needs no Azure, Teams, Oracle or LLM credentials: MOCK_MODE routes Graph and
 * Teams to fixtures and extraction to the offline heuristic extractor.
 */
process.env.MOCK_MODE = process.env.MOCK_MODE || 'true';
// An in-memory database per run, so re-running does not trip the bot's
// already-briefed guard and every assertion sees a clean slate.
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const { processMeeting } = require('../src/pipeline');
const { NEEDS_CONFIRMATION } = require('../src/docgen/fillTemplate');
const meetingsDb = require('../src/db/meetings');

// What each fixture is meant to prove.
const EXPECTED = {
  'client-meeting': { status: 'processed', answerUncertain: null },
  'internal-standup': { status: 'skipped', answerUncertain: null },
  'ambiguous-meeting': { status: 'processed', answerUncertain: true },
};

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function docText(filePath) {
  const xml = new PizZip(fs.readFileSync(filePath))
    .file('word/document.xml')
    .asText();
  return xml
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&');
}

const checks = [];
function check(label, passed, detail) {
  checks.push({ label, passed, detail });
  const mark = passed ? green('PASS') : red('FAIL');
  console.log(`   ${mark}  ${label}${detail ? dim('  ' + detail) : ''}`);
}

async function runFixture(name) {
  const expected = EXPECTED[name] || {};
  console.log('\n' + bold(`── ${name} ─────────────────────────────────`));

  const result = await processMeeting({
    fixture: name,
    // Stands in for the user tapping Yes/No on the "was this a client meeting?"
    // card, so the uncertain branch is exercised without a Teams client.
    onUncertain: async (meeting) => {
      console.log(dim(`   (bot asked: was "${meeting.subject}" a client meeting?)`));
      return expected.answerUncertain === true;
    },
  });

  console.log(dim(`   filter: ${result.verdict?.decision} (${result.verdict?.reason})`));
  check(
    `status is "${expected.status}"`,
    result.status === expected.status,
    `got "${result.status}"`
  );

  if (result.status !== 'processed') return;

  const { cbd, filePath } = result;
  console.log(dim(`   provider: ${cbd._provider}  ·  avg confidence: ${cbd.confidenceAvg}/5`));
  console.log(dim(`   output: ${filePath}`));

  check('document written', fs.existsSync(filePath));

  const text = docText(filePath);
  check(
    'project name in document',
    cbd.projectName && text.includes(cbd.projectName.slice(0, 20)),
    cbd.projectName
  );
  check(
    'business objective in document',
    text.includes(cbd.businessObjective.split('\n')[0].slice(0, 30))
  );

  const ticked = (text.match(/☒/g) || []).length;
  const expectedTicks = Object.values(cbd.checkboxes).reduce(
    (n, list) => n + list.length,
    0
  );
  check(
    'every selected checkbox is ticked',
    ticked === expectedTicks,
    `${ticked} ticked / ${expectedTicks} selected`
  );

  const flagged = text.includes(NEEDS_CONFIRMATION.trim());
  check(
    cbd.needsConfirmation.length
      ? 'low-confidence fields flagged'
      : 'no spurious confirmation flags',
    cbd.needsConfirmation.length ? flagged : !flagged,
    cbd.needsConfirmation.join(', ') || 'nothing below confidence 3'
  );

  const logs = meetingsDb.findByMeetingId(result.meeting.id, result.meeting.dramantramUser?.id);
  const row = logs.find((r) => r.cbd_generated === 1);
  check('meeting_logs row written', Boolean(row));
  if (row) {
    check(
      'log records the generated file and confidence',
      row.cbd_file_path === filePath && row.confidence_avg === cbd.confidenceAvg,
      `${row.filter_result} · ${row.transcript_source} · avg ${row.confidence_avg}`
    );
  }

  console.log(dim('\n   extracted fields:'));
  for (const field of [
    'projectName', 'launchDate', 'spoc', 'escalationPoint',
    'keyMessage', 'callToAction', 'audienceProfile',
  ]) {
    const value = String(cbd[field] || '').replace(/\n/g, ' ');
    console.log(
      dim(
        `     ${field.padEnd(17)} [${cbd.confidence[field]}] ${
          value.slice(0, 68) || '(empty)'
        }`
      )
    );
  }
  for (const [group, labels] of Object.entries(cbd.checkboxes)) {
    console.log(dim(`     ${('☑ ' + group).padEnd(17)}     ${labels.join(', ')}`));
  }
}

async function main() {
  const only = process.argv[2];
  const fixtures = only ? [only] : Object.keys(EXPECTED);
  fs.mkdirSync(path.join(__dirname, '..', 'dist', 'output'), { recursive: true });

  console.log(bold('\nCBD Bot end-to-end run (MOCK_MODE)\n'));
  for (const name of fixtures) {
    await runFixture(name);
  }

  const failed = checks.filter((c) => !c.passed);
  console.log(
    '\n' +
      bold(
        failed.length
          ? red(`${failed.length} of ${checks.length} checks failed`)
          : green(`all ${checks.length} checks passed`)
      ) +
      '\n'
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
