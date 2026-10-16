// The owner fields of a CBD (name, email, phone) come from the organiser's own
// profile, read with the sign-in the bot already holds. The Graph client is
// stubbed, before attendees is first required, because attendees binds it then.
const clientModule = require('../src/graph/client');
const auth = require('../src/graph/auth');

// What Graph really returns for a meeting: the address is `upn` on the participant, the identity inside has only an id.
const identity = { user: { '@odata.type': '#microsoft.graph.communicationsUserIdentity', id: 'guid', tenantId: 'tenant' } };
let MEETING = {
  id: 'meeting-1',
  subject: 'Newsletter kickoff',
  joinWebUrl: 'https://teams/x',
  participants: {
    organizer: { upn: 'dev@dramantram.com', role: 'presenter', identity },
    attendees: [{ upn: 'shlok.k@dramantram.com', role: 'attendee', identity }],
  },
};

// attendees binds graphClient once, when first required, so the stub is installed
// once here and each test only changes what the profile call answers.
let me;
vi.spyOn(auth, 'getDelegatedToken').mockResolvedValue('token');
vi.spyOn(clientModule, 'graphClient').mockImplementation(() => ({
  api: (url) => {
    const chain = {
      select: () => chain,
      filter: () => chain,
      get: async () => {
        if (url === '/me') return me();
        if (url.endsWith('/attendanceReports')) throw new Error('not available');
        return MEETING;
      },
    };
    return chain;
  },
}));
const { getMeetingDetails } = require('../src/graph/attendees');

describe('the project owner of a real meeting', () => {
  it('is the signed-in organiser, with name, email and phone from their profile', async () => {
    me = () => ({ displayName: 'Dev Maheshwari', mail: 'dev@dramantram.com', mobilePhone: '+91 98000 00000' });
    const meeting = await getMeetingDetails({ meetingId: 'meeting-1', userId: 'user-1' });
    expect(meeting.dramantramUser).toEqual({ id: 'user-1', displayName: 'Dev Maheshwari', email: 'dev@dramantram.com', phone: '+91 98000 00000' });
  });

  it('falls back to the sign-in name for email and the office line for phone', async () => {
    me = () => ({ displayName: 'Dev', userPrincipalName: 'dev@dramantram.com', businessPhones: ['011 4000 0000'] });
    const { dramantramUser } = await getMeetingDetails({ meetingId: 'meeting-1', userId: 'u' });
    expect(dramantramUser).toMatchObject({ email: 'dev@dramantram.com', phone: '011 4000 0000' });
  });

  it('leaves the owner blank, not invented, when the profile cannot be read', async () => {
    me = () => { throw new Error('403'); };
    const meeting = await getMeetingDetails({ meetingId: 'meeting-1', userId: 'u' });
    expect(meeting.dramantramUser).toEqual({ id: 'u' });
  });
});

describe('who was invited', () => {
  it('reads each person\'s address from the participant, so an invited colleague is known to be internal', async () => {
    me = () => ({ displayName: 'Dev', mail: 'dev@dramantram.com' });
    const meeting = await getMeetingDetails({ meetingId: 'meeting-1', userId: 'u' });
    expect(meeting.attendees.map((a) => a.email).sort()).toEqual(['dev@dramantram.com', 'shlok.k@dramantram.com']);
    expect(meeting.attendees.every((a) => a.email)).toBe(true); // nobody is left as an unidentified guest
    expect(meeting.hostedBy).toBe('dramantram');
  });

  it('keeps an outside guest\'s address, so the meeting is a client meeting', async () => {
    me = () => ({ displayName: 'Dev', mail: 'dev@dramantram.com' });
    MEETING = { ...MEETING, participants: { ...MEETING.participants, attendees: [{ upn: 'ananya@verdant.com', role: 'attendee', identity }] } };
    const meeting = await getMeetingDetails({ meetingId: 'meeting-1', userId: 'u' });
    expect(meeting.attendees.map((a) => a.email)).toContain('ananya@verdant.com');
  });
});
