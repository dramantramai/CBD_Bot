const welcomeCard = require('./welcomeCard.json');
const uncertainMeetingCard = require('./uncertainMeetingCard.json');
const confirmMeetingCard = require('./confirmMeetingCard.json');
const chooseOutputCard = require('./chooseOutputCard.json');
const cbdReadyCard = require('./cbdReadyCard.json');

// Replaces ${token} placeholders anywhere in a card template. Kept deliberately
// small so cards stay plain JSON that anyone can edit without learning a
// templating library.
function render(template, data = {}) {
  const walk = (node) => {
    if (typeof node === 'string') {
      return node.replace(/\$\{(\w+)\}/g, (match, key) =>
        data[key] === undefined || data[key] === null ? '' : String(data[key])
      );
    }
    if (Array.isArray(node)) {
      // A TextBlock whose only content was an unset ${token} (e.g. an
      // optional warning banner) renders as an empty line otherwise - drop it.
      return node
        .map(walk)
        .filter((el) => !(el && el.type === 'TextBlock' && el.text === ''));
    }
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node).map(([k, v]) => [k, walk(v)])
      );
    }
    return node;
  };
  return walk(template);
}

/**
 * Which project is this? One card: a suggestion when there is one, the list of
 * existing projects, and two boxes for a new one. Built in code, not from a
 * template, because the list and the optional suggestion change every time.
 */
function buildProjectCard({ meetingId, title, suggestion, projects }) {
  const data = (mode, extra = {}) => ({ action: 'chooseProject', meetingId, mode, ...extra });
  const body = [
    { type: 'TextBlock', text: 'Which project is this for?', weight: 'Bolder', size: 'Medium' },
    { type: 'TextBlock', text: title, wrap: true, isSubtle: true },
  ];
  const actions = [];
  if (suggestion) {
    body.push({ type: 'TextBlock', text: `This looks like **${suggestion.project.client_name} - ${suggestion.project.project_name}**. ${suggestion.reason}`, wrap: true });
    actions.push({ type: 'Action.Submit', title: 'Yes, that one', data: data('suggested') });
  }
  if (projects.length) {
    body.push({
      type: 'Input.ChoiceSet',
      id: 'projectId',
      style: 'compact',
      placeholder: 'Or pick another project',
      choices: projects.map((p) => ({ title: `${p.client_name} - ${p.project_name}`, value: p.id })),
    });
    actions.push({ type: 'Action.Submit', title: 'Use the selected project', data: data('existing') });
  }
  body.push(
    { type: 'TextBlock', text: 'Or start a new project:', wrap: true },
    { type: 'Input.Text', id: 'clientName', placeholder: 'Client name' },
    { type: 'Input.Text', id: 'projectName', placeholder: 'Project name' }
  );
  actions.push({ type: 'Action.Submit', title: 'Create new project', data: data('new') });
  return { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body, actions };
}

module.exports = {
  buildProjectCard,
  render,
  buildWelcomeCard: (data) => render(welcomeCard, data),
  buildUncertainMeetingCard: (data) => render(uncertainMeetingCard, data),
  buildConfirmMeetingCard: (data) => render(confirmMeetingCard, data),
  buildChooseOutputCard: (data) => render(chooseOutputCard, data),
  buildCbdReadyCard: (data) => render(cbdReadyCard, data),
};
