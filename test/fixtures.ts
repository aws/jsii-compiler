import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lock, unlock } from 'lockfile';
import { DiagnosticCategory } from 'typescript';
import { Compiler } from '../src/compiler';
import { loadProjectInfo } from '../src/project-info';
import { formatDiagnostic } from '../src/utils';

/**
 * The root directory in which fixtures are located.
 */
export const FIXTURES_ROOT = resolve(__dirname, '..', 'fixtures');

/**
 * Compiles the specified fixture module.
 *
 * @param _lock a lock acquired on the fixtures directory (only there to guarantee a lock was acquired).
 * @param name the name of the fixture module to compile.
 * @param addDeprecationWarnings whether deprecation warnings should be added.
 * @param stripDeprecated if present, deprecated members will be stripped unless they are in the file at this path.
 *
 * @returns the root directory of the fixture module.
 */
export function compile(_lock: Lock, name: string, addDeprecationWarnings: boolean, stripDeprecated?: string) {
  const projectRoot = join(FIXTURES_ROOT, name);

  expect(existsSync(projectRoot)).toBeTruthy();

  const { projectInfo } = loadProjectInfo(projectRoot);

  const compiler = new Compiler({
    projectInfo,
    addDeprecationWarnings,
    stripDeprecated: stripDeprecated != null,
    stripDeprecatedAllowListFile: stripDeprecated && resolve(projectRoot, stripDeprecated),
  });

  const result = compiler.emit();
  expect(
    result.diagnostics
      .filter((diag) => diag.category === DiagnosticCategory.Error)
      .map((diag) => formatDiagnostic(diag, projectRoot))
      .join('\n'),
  ).toEqual('');
  expect(result).toHaveProperty('emitSkipped', false);

  return projectRoot;
}

export interface LockOptions {
  /**
   * When using opts.wait, this is the period in ms in which it polls to check if the lock has expired. Defaults to 100.
   *
   * @default 100
   */
  readonly pollPeriod?: number;

  /**
   * A number of milliseconds before locks are considered to have expired.
   *
   * @default 120_000
   */
  readonly stale?: number;

  /**
   * A number of milliseconds to wait for locks to expire before giving up. Poll for opts.wait ms. If the lock is not
   * cleared by the time the wait expires, then it returns with the original error.
   *
   * @default 120_000
   */
  readonly wait?: number;
}

export class Lock {
  /**
   * Acquires a filesystem lock on the fixtures directory.
   *
   * It is the caller's responsibility to call `release()` on the returned
   * lock in order to release the resource.
   *
   * @returns the acquired lock.
   */
  public static acquire({ pollPeriod, stale = 120_000, wait = 120_000 }: LockOptions = {}): Promise<Lock> {
    return new Promise((ok, ko) => {
      lock(Lock.#LOCKFILE, { pollPeriod, stale, wait }, (err) => {
        if (err != null) {
          return ko(err);
        }
        return ok(new Lock());
      });
    });
  }

  static readonly #LOCKFILE = join(FIXTURES_ROOT, '.lock');

  /**
   * Releases the resource that has been acquired by this lock.
   */
  public release(): Promise<void> {
    return new Promise<void>((ok, ko) =>
      unlock(Lock.#LOCKFILE, (err) => {
        if (err != null) {
          return ko(err);
        }
        return ok();
      }),
    );
  }
}
