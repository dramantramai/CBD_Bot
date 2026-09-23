const fs = require('fs');
const path = require('path');

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'fixtures', 'meetings');

function loadFixture(name) {
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No meeting fixture named "${name}"`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function allFixtures() {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadFixture(path.basename(f, '.json')));
}

async function getMeetingDetails({ meetingId, fixture }) {
  if (fixture) return loadFixture(fixture);
  const match = allFixtures().find((m) => m.id === meetingId);
  if (!match) throw new Error(`No meeting fixture matching id ${meetingId}`);
  return match;
}

module.exports = { getMeetingDetails, loadFixture, allFixtures };
