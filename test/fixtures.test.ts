import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lock } from './fixtures';

// These tests use their own lock file, so they never wait for the tests that hold the lock on the fixtures.
describe('Lock', () => {
  let lockFile: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'jsii-lock-test-'));
    lockFile = join(tempDir, '.lock');
  });

  afterEach(() => {
    rmSync(tempDir, { force: true, recursive: true });
  });

  test('cannot be acquired twice', async () => {
    const lock = await Lock.acquire({ lockFile });
    try {
      await expect(Lock.acquire({ lockFile, wait: 0 })).rejects.toThrow(/EEXIST/);
    } finally {
      await lock.release();
    }
  });

  test('can be acquired again once released', async () => {
    const first = await Lock.acquire({ lockFile });
    await first.release();

    const second = await Lock.acquire({ lockFile });
    await second.release();
  });
});
