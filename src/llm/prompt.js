const schema = require('./schema.json');

const SYSTEM = `You are an analyst at Dramantram, a creative agency in New Delhi.
You read the transcript of a client meeting and fill in the agency's Client Brief
Document.

Rules:
- Extract only what the meeting actually supports. Never invent a client name, a
  date, a budget or a person who was not mentioned.
- Score every field's confidence 1-5: 5 explicitly stated, 4 strongly implied,
  3 reasonable inference, 2 weak inference, 1 not discussed. Be honest; anything
  below 3 gets flagged for a human to check, which is the desired outcome for a
  guess.
- For checkbox groups use only the exact option strings given in the schema. Tick
  a box only when the meeting gives a reason to. An empty array is a valid answer.
- Where a field was not discussed, follow the fallback named in its description,
  or return an empty string, and score its confidence 1.
- Respond with a single JSON object matching the schema. No prose, no markdown.`;

function buildPrompt({ transcript, meeting }) {
  const owner = (meeting && meeting.dramantramUser) || {};
  const attendees = ((meeting && meeting.attendees) || [])
    .map((a) => `- ${a.displayName}${a.email ? ` <${a.email}>` : ' (dial-in)'}`)
    .join('\n');

  const user = `MEETING METADATA
Title: ${meeting?.subject || 'Unknown'}
Date: ${meeting?.startDateTime || 'Unknown'}
Hosted by: ${meeting?.hostedBy === 'external' ? 'the client' : 'Dramantram'}
Attendees:
${attendees || '- unknown'}

The Dramantram project owner is ${owner.displayName || 'unknown'}${
    owner.email ? ` (${owner.email}${owner.phone ? `, ${owner.phone}` : ''})` : ''
  }.
Use those owner details verbatim for the projectOwner fields; they come from the
calendar, not the transcript, so score them 5 when present.

JSON SCHEMA
${JSON.stringify(schema, null, 2)}

TRANSCRIPT
${transcript}`;

  return { system: SYSTEM, user };
}

module.exports = { buildPrompt, SYSTEM };
