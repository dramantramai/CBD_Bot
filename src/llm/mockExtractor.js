/**
 * Offline stand-in for the real LLMs so the whole pipeline runs with no API key.
 * It is deliberately heuristic rather than a canned response: different
 * transcripts produce visibly different briefs, which is what makes the E2E run
 * worth looking at. It is NOT a fallback for production - extractCBD only
 * reaches for it when MOCK_MODE is on or no provider key is configured.
 */
const checkboxMap = require('../docgen/checkboxMap.json');

const GROUPS = {};
for (const v of Object.values(checkboxMap)) (GROUPS[v.group] ||= []).push(v.label);

// A box is ticked when any of its cues appears in the transcript.
const CUES = {
  audience: {
    'End Customer': ['end customer', 'consumer', 'customers', 'members', 'audience is'],
    'Executive & Management': ['executive', 'leadership', 'management team'],
    'Internal team': ['internal team', 'our employees', 'staff'],
    'External Partners': ['partners', 'distributors', 'resellers'],
    'Webpage Visitors': ['website visitors', 'landing page', 'site visitors'],
  },
  emotions: {
    Happy: ['happy', 'joy', 'feel good', 'delight'],
    Sad: ['sad', 'melancholy'],
    Surprised: ['surprise', 'surprising'],
    Fear: ['fear', 'anxiety', 'worry'],
  },
  feeling: {
    Curious: ['curious', 'curiosity', 'discovering', 'discover'],
    Inspired: ['inspired', 'inspiring', 'aspirational'],
    Informed: ['informed', 'educate', 'explain'],
    Safe: ['safe', 'trust', 'reliable', 'dependable'],
    Scared: ['scared'],
  },
  tone: {
    Warm: ['warm', 'human', 'approachable', 'friendly'],
    Formal: ['formal', 'corporate', 'professional tone'],
    'Fun/Witty': ['fun', 'witty', 'playful', 'jokey', 'light'],
    Casual: ['casual', 'relaxed', 'conversational'],
  },
  releasePlatform: {
    Website: ['website', 'web', 'site'],
    'social media': ['social media', 'instagram', 'social'],
    'TV/ Broadcasting': ['tv', 'broadcast', 'television'],
  },
  languageMedium: { English: ['english'], Hindi: ['hindi'] },
  accent: { Indian: ['indian'], USA: ['american accent', 'us accent'], UK: ['british', 'uk accent'] },
  availableResources: {
    'Brand Guideline': ['brand guidelines we have', 'existing brand guidelines'],
    'Logo Open files': ['logo open files', 'logo files', 'ai files', 'source files'],
    'Project Open Files': ['project open files', 'project files'],
  },
  contentConsulting: {
    'Content Planning': ['content plan', 'content calendar', 'content strategy'],
    'Creative Project executions': ['campaign', 'creative execution', 'activation'],
  },
  design: {
    'Brand Identity guidelines': ['brand identity', 'brand guidelines', 'identity system', 'logo'],
    'Social Media Branding': ['social media branding', 'social templates', 'instagram', 'visual language'],
    'Magazine & Print designs': ['print', 'magazine', 'packaging'],
    'Report/ PPT design': ['report design', 'presentation design', 'ppt'],
  },
  video: {
    'Adv. Film/ TVC': ['brand film', 'tvc', 'ad film'],
    'Animated Explainers': ['explainer', 'animation'],
    'Sales & Marketing video': ['marketing video', 'sales video', 'short form'],
    'L&D/e-Learning Videos': ['e-learning', 'training video'],
    'Stock based Videos': ['stock footage'],
    'Live Action video': ['live action', 'shoot'],
  },
  smm: {
    'Brand Presence/Awareness': ['awareness', 'brand presence', 'visibility'],
    'Grow your Audience/Market': ['grow', 'sign-ups', 'signups', 'acquisition', 'new members'],
  },
};

// A negation in the same sentence means the client ruled that option out.
const NEGATIONS = [
  'not in this phase', 'no tv', 'not scope', "let's not", 'undercuts',
  'not doing', "don't want", 'do not want', 'not at all', 'no ', 'not ',
];

const MONTHS =
  '(january|february|march|april|may|june|july|august|september|october|november|december)';

const WORD_NUMBERS =
  '(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|' +
  'twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|' +
  'nineteenth|twentieth|thirtieth|\\d{1,2}(?:st|nd|rd|th)?)';

/** Pulls "15 November" / "the fifteenth of November" / "end of October" out of a sentence. */
function datePhrase(sentence) {
  if (!sentence) return null;
  const patterns = [
    new RegExp(`\\b${WORD_NUMBERS}\\s+(?:of\\s+)?${MONTHS}(?:\\s+\\d{4})?`, 'i'),
    new RegExp(`\\b${MONTHS}\\s+${WORD_NUMBERS}(?:,?\\s+\\d{4})?`, 'i'),
    new RegExp(`\\b(?:end|start|middle|beginning)\\s+of\\s+${MONTHS}`, 'i'),
    new RegExp(`\\bbefore\\s+${MONTHS}`, 'i'),
    new RegExp(`\\b(?:by|before)\\s+([A-Z][a-z]+)\\b`),
  ];
  for (const p of patterns) {
    const m = sentence.match(p);
    if (m) return m[0].replace(/^(by|before)\s+/i, (x) => x.toLowerCase());
  }
  return null;
}

// Sentences still carry the "Speaker Name: " prefix the VTT parser added, and
// the speaker is not the person the sentence is about.
const stripSpeaker = (s) =>
  String(s || '').replace(/^[A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+)*:\s*/, '');

/** Resolves a first name in a sentence back to the full attendee record. */
function personIn(sentence, meeting) {
  const body = stripSpeaker(sentence);
  if (!body) return null;
  for (const a of (meeting && meeting.attendees) || []) {
    if (!a.displayName) continue;
    const first = a.displayName.split(/\s+/)[0];
    if (new RegExp(`\\b${first}\\b`, 'i').test(body)) return a;
  }
  return null;
}

/** "he's our Head of Marketing" -> "Head of Marketing". */
function roleIn(sentence) {
  if (!sentence) return null;
  const m = sentence.match(
    /\b(?:our|the|is the|as)\s+((?:Head|VP|Director|Manager|Lead|Chief|Founder|Co-founder|CEO|CMO|CTO|Owner)[^,.;]*)/i
  );
  const titleCase = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  if (m) return titleCase(m[1].trim());
  if (/\bfounder\b/i.test(sentence)) return 'Founder';
  return null;
}

/** Who said this line, from the "Name: text" prefix the VTT parser produced. */
function speakerOf(sentence, fullText) {
  // The first sentence of a turn carries the prefix itself.
  const own = String(sentence || '').match(/^([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+)*):/);
  if (own) return own[1];

  const idx = fullText.indexOf(sentence);
  if (idx === -1) return '';
  const before = fullText.slice(0, idx);
  const line = before.slice(before.lastIndexOf('\n') + 1);
  const m = line.match(/^([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+)*):/);
  return m ? m[1] : '';
}

/** The role is often stated in the following sentence ("I'm the founder"). */
function nextSentence(sents, sentence) {
  const i = sents.indexOf(sentence);
  return i === -1 ? null : sents[i + 1] || null;
}

function describePerson(sentence, meeting) {
  const person = personIn(sentence, meeting);
  const role = roleIn(sentence);
  if (person && role) return `${person.displayName}, ${role}`;
  if (person) return person.displayName;
  return '';
}

function sentences(text) {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function findSentence(sents, patterns) {
  for (const p of patterns) {
    const hit = sents.find((s) => p.test(s));
    if (hit) return hit;
  }
  return null;
}

/**
 * When a cue lands on the agency's question ("what's the action we want?"),
 * the answer is in the next turn, not the matched sentence.
 */
function findAnswer(sents, patterns) {
  for (const p of patterns) {
    const i = sents.findIndex((s) => p.test(s));
    if (i === -1) continue;
    if (!isQuestion(sents[i])) return sents[i];
    const next = sents.slice(i + 1).find((s) => !isQuestion(s) && s.length > 12);
    if (next) return next;
  }
  return null;
}

const isQuestion = (s) => s.trim().endsWith('?');

// Negation only counts when it sits just before the cue. Scanning the whole
// sentence throws away good matches: "happy, cooking should feel good, not like
// a chore" is not a negation of "happy".
function isNegated(sentence, cue) {
  const sl = sentence.toLowerCase();
  if (NEGATIONS.some((n) => n.length > 5 && sl.includes(n))) return true;
  const at = sl.indexOf(cue);
  if (at === -1) return false;
  const before = sl.slice(Math.max(0, at - 25), at);
  return /\b(no|not|never|without|skip|drop)\b[\s,]*$/.test(before);
}

function tickBoxes(sents) {
  const out = {};
  for (const [group, options] of Object.entries(CUES)) {
    const picked = [];
    for (const [label, cues] of Object.entries(options)) {
      if (!GROUPS[group] || !GROUPS[group].includes(label)) continue;

      // A box needs at least one plain statement backing it. Questions are the
      // agency probing ("Any broadcast or TV?") and negations are the client
      // ruling it out ("No TV") - neither is a reason to tick.
      const clean = sents.filter((s) => {
        if (isQuestion(s)) return false;
        const sl = s.toLowerCase();
        return cues.some((c) => sl.includes(c) && !isNegated(s, c));
      });
      if (clean.length === 0) continue;
      picked.push(label);
    }
    if (picked.length) out[group] = picked;
  }
  return out;
}

function clientNameFromTranscript(text) {
  const m = text.match(
    /\b([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+){0,2})\s+is\s+(?:our|a|an|opening)/
  );
  if (!m) return '';
  // Drop the filler word a sentence often opens with ("So Mistral Fitness is...").
  return m[1].replace(/^(So|And|But|Well|Okay|Now|Right)\s+/i, '').trim();
}

function clientName(meeting) {
  const subject = (meeting && meeting.subject) || '';
  const beforeSeparator = subject.split(/\s+[x×]\s+|\s+-\s+|\s+\|\s+/i)[0].trim();
  if (beforeSeparator && !/^(catch|call|sync|meeting)/i.test(beforeSeparator)) {
    return beforeSeparator;
  }
  // Fall back to an external attendee's domain, e.g. mistralfitness.in -> Mistral Fitness.
  const external = (meeting?.attendees || []).find(
    (a) => a.email && !a.email.endsWith('@dramantram.com')
  );
  if (external) {
    const host = external.email.split('@')[1].split('.')[0];
    return host.charAt(0).toUpperCase() + host.slice(1);
  }
  return '';
}

function extract({ transcript, meeting }) {
  const text = String(transcript || '');
  const lower = text.toLowerCase();
  const sents = sentences(text);
  const owner = (meeting && meeting.dramantramUser) || {};
  const conf = {};
  const set = (score) => score;

  const name = clientName(meeting) || clientNameFromTranscript(text);
  const subject = meeting?.subject || '';
  const projectName = name
    ? `${name}${/brand|website|campaign|identity/i.test(subject) ? ' - ' + subject.replace(/^.*?[-–]\s*/, '') : ''}`.trim()
    : 'Untitled project';
  conf.projectName = name ? 4 : 1;

  // Dates: "fifteenth of November", "end of October", "by 15 November".
  const dateSentence = findSentence(sents, [
    new RegExp(`(by|before|deliver\\w*|targeting|live)[^.]*${MONTHS}`, 'i'),
    new RegExp(`${MONTHS}`, 'i'),
  ]);
  const phrase = datePhrase(dateSentence);
  const launchDate = phrase || 'TBD, confirm with client';
  conf.launchDate = phrase ? 4 : 1;

  const spocSentence = findSentence(sents, [
    /\bspoc\b/i,
    /main (point of )?contact/i,
    /day to day/i,
  ]);
  const escalationSentence = findSentence(sents, [/escalat/i, /unblock/i]);

  const objectiveSentences = sents
    .filter((s) => /objective|problem|reposition|we need|we want|the idea is|launch/i.test(s))
    .slice(0, 3);
  const usedInObjective = new Set(objectiveSentences);
  const scopeSentences = sents
    .filter(
      (s) =>
        !usedInObjective.has(s) &&
        /deliverab|we're looking at|brand identity|guidelines|website|social media branding|campaign|templates/i.test(s)
    )
    .slice(0, 4);

  const keySentence = findAnswer(sents, [
    /something like ([^.]+)/i,
    /essence/i,
    /the message is/i,
  ]);
  const ctaSentence = findAnswer(sents, [
    /action we want/i,
    /what do they do next/i,
    /order your/i,
    /book a/i,
  ]);
  const audienceSentence = findSentence(sents, [
    /\d{2}\s*(?:to|-|–)\s*\d{2}/,
    /(?:twenty|thirty|forty|fifty)[\s-]\w+\s+(?:to|and)\s+(?:twenty|thirty|forty|fifty)/i,
    /\b(?:households|income|professionals|demographic)\b/i,
    /audience is/i,
  ]);

  const trim = (s, words) =>
    s ? s.split(/\s+/).slice(0, words).join(' ').replace(/[,.]$/, '') : '';

  conf.businessObjective = objectiveSentences.length ? 4 : 1;
  conf.solutionScope = scopeSentences.length ? 4 : 1;
  conf.keyMessage = keySentence ? 3 : 1;
  conf.callToAction = ctaSentence ? 3 : 1;
  conf.audienceProfile = audienceSentence ? 3 : 1;
  const spocName = describePerson(spocSentence, meeting);
  // The person telling you to escalate to them is naming themselves.
  const escalationName =
    escalationSentence && /\bto me\b|\bmyself\b/i.test(escalationSentence)
      ? [speakerOf(escalationSentence, text), roleIn(nextSentence(sents, escalationSentence))]
          .filter(Boolean)
          .join(', ')
      : describePerson(escalationSentence, meeting);
  conf.spoc = spocName ? 4 : 1;
  conf.escalationPoint = escalationName ? 3 : 1;
  conf.projectOwnerName = owner.displayName ? 5 : 1;
  conf.projectOwnerEmail = owner.email ? 5 : 1;
  conf.projectOwnerPhone = owner.phone ? 5 : 1;
  conf.otherMentions = 2;
  conf.releasePlatformOther = 1;
  conf.languageMediumOther = 1;
  conf.accentOther = 1;
  conf.availableResourcesOther = 1;

  return {
    projectName,
    launchDate,
    projectOwnerName: owner.displayName || '',
    projectOwnerEmail: owner.email || '',
    projectOwnerPhone: owner.phone || '',
    spoc: spocName,
    escalationPoint: escalationName,
    businessObjective:
      objectiveSentences.map((s) => s.replace(/^[^:]*:\s*/, '').trim()).join('\n') ||
      'Summarised from meeting purpose; not explicitly discussed.',
    solutionScope:
      scopeSentences.map((s) => s.replace(/^[^:]*:\s*/, '').trim()).join('\n') || '',
    keyMessage: trim(
      keySentence && keySentence.match(/something like ([^.]+)/i)
        ? keySentence.match(/something like ([^.]+)/i)[1]
        : keySentence,
      10
    ) || 'To be refined post-brief',
    callToAction:
      trim(ctaSentence ? ctaSentence.replace(/^[^:]*:\s*/, '') : '', 10) ||
      'To be defined',
    audienceProfile: audienceSentence
      ? audienceSentence.replace(/^[^:]*:\s*/, '').trim()
      : '',
    otherMentions: '',
    releasePlatformOther: '',
    languageMediumOther: '',
    accentOther: '',
    availableResourcesOther: '',
    clientOrgOverview: ['', ''],
    checkboxes: tickBoxes(sents),
    confidence: conf,
    _provider: 'mock',
  };
}

module.exports = { extract, GROUPS, CUES };
