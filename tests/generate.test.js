const { generateJson } = require('../src/llm/generate');

const provider = (name, run) => ({ name, run });

describe('generateJson', () => {
  it('returns the first provider that answers', async () => {
    const chain = [provider('a', async () => ({ from: 'a' })), provider('b', async () => ({ from: 'b' }))];
    expect(await generateJson({ system: 's', user: 'u' }, { chain })).toEqual({ from: 'a' });
  });

  it('falls through a failing provider to the next', async () => {
    const chain = [
      provider('a', async () => { throw new Error('quota'); }),
      provider('b', async () => ({ from: 'b' })),
    ];
    expect(await generateJson({ system: 's', user: 'u' }, { chain })).toEqual({ from: 'b' });
  });

  it('passes the prompt through untouched', async () => {
    let seen;
    const chain = [provider('a', async (prompt) => { seen = prompt; return {}; })];
    await generateJson({ system: 'SYS', user: 'USER' }, { chain });
    expect(seen).toEqual({ system: 'SYS', user: 'USER' });
  });

  it('returns null, not an error, when no provider is configured', async () => {
    expect(await generateJson({ system: 's', user: 'u' }, { chain: [] })).toBeNull();
  });

  it('raises when providers exist and all fail, so an outage is never read as an empty answer', async () => {
    const chain = [
      provider('a', async () => { throw new Error('quota'); }),
      provider('b', async () => { throw new Error('down'); }),
    ];
    await expect(generateJson({ system: 's', user: 'u' }, { chain })).rejects.toThrow(/a: quota; b: down/);
  });
});
