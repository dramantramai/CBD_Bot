const welcomeCard = require('./welcomeCard.json');
const uncertainMeetingCard = require('./uncertainMeetingCard.json');
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

module.exports = {
  render,
  buildWelcomeCard: (data) => render(welcomeCard, data),
  buildUncertainMeetingCard: (data) => render(uncertainMeetingCard, data),
  buildCbdReadyCard: (data) => render(cbdReadyCard, data),
};
