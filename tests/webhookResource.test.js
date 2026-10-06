import { describe, it, expect } from 'vitest';
import pkg from '../src/routes/webhook.js';
const { resourceSegment } = pkg;

// Copied verbatim from a notification Graph actually sent. Earlier code
// assumed plain path segments, so every real notification was discarded with
// "missing user or meeting id" - which looks exactly like not being notified.
const REAL =
  "users('ffd1a063-a87e-49c7-8671-93a4f918fc82')" +
  "/onlineMeetings('MSpmZmQxYTA2My1hODdlLTQ5YzctODY3MS05M2E0ZjkxOGZjODIqMCoqMTk6bWVldGluZ19NRGxrWVdJeU5UY3RORFU0TUMwME9HSXdMVGhtWWprdFpqVmxNelZtTldWbU9UWmtAdGhyZWFkLnYy')" +
  "/transcripts('ktVizIrGAAAAjPB7lQTZRTE5Om1lZXRpbmdf')";

describe('resourceSegment', () => {
  it('reads ids from the OData form Graph sends', () => {
    expect(resourceSegment(REAL, 'users')).toBe(
      'ffd1a063-a87e-49c7-8671-93a4f918fc82'
    );
    expect(resourceSegment(REAL, 'onlineMeetings')).toMatch(/^MSpmZmQxYTA2My1/);
  });

  it('still reads the plain path form', () => {
    const path = 'users/abc-123/onlineMeetings/meeting-456/transcripts/t1';
    expect(resourceSegment(path, 'users')).toBe('abc-123');
    expect(resourceSegment(path, 'onlineMeetings')).toBe('meeting-456');
  });

  it('keeps a slash inside a quoted id, since meeting ids are base64', () => {
    const withSlash = "users('u1')/onlineMeetings('ab/cd+ef==')";
    expect(resourceSegment(withSlash, 'onlineMeetings')).toBe('ab/cd+ef==');
  });

  it('returns undefined rather than a wrong id when absent', () => {
    expect(resourceSegment('', 'users')).toBeUndefined();
    expect(resourceSegment("teams('x')", 'users')).toBeUndefined();
  });
});
