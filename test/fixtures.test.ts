import { Lock } from './fixtures';

describe('Lock', () => {
  test('cannot be acquired twice', async () => {
    const lock = await Lock.acquire();
    try {
      await expect(Lock.acquire({ wait: 0 })).rejects.toThrow(/EEXIST/);
    } finally {
      await lock.release();
    }
  });

  test('can be acquired again once released', async () => {
    const first = await Lock.acquire();
    await first.release();

    const second = await Lock.acquire();
    await second.release();
  });
});
