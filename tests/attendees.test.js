// The owner fields of a CBD (name, email, phone) come from the organiser's own
// profile, read with the sign-in the bot already holds. The Graph client is
// stubbed, before attendees is first required, because attendees binds it then.
const clientModule = require('../src/graph/client');
const auth = require('../src/graph/auth');

const MEETING = {
  id: 'meeting-1',
  subject: 'Newsletter kickoff',
  joinWebUrl: 'https://teams/x',
  participants: { organizer: { identity: { user: { displayName: 'Dev Maheshwari', userPrincipalName: 'dev@dramantram.com' } } }, attendees: [] },
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
