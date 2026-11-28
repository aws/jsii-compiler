import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeProjectInfo } from './make-project-info';
import { Compiler } from '../../../src/compiler';

const base = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    compilerOptions: { target: 'es2022', module: 'commonjs', declaration: true, strict: true, ...extra },
  });

test('watch mode builds again for the files of the program, its tsconfig and new included files', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'jsii-watch-inputs-'));
  mkdirSync(join(sourceDir, 'src'));
  writeFileSync(join(sourceDir, 'base.json'), base());
  writeFileSync(join(sourceDir, 'tsconfig.json'), JSON.stringify({ extends: './base.json', include: ['src/**/*.ts'] }));
  writeFileSync(join(sourceDir, 'src', 'index.ts'), 'export class Klass {}');
  writeFileSync(join(sourceDir, 'README.md'), '# Test Package');

  const compiler = new Compiler({
    projectInfo: makeProjectInfo(sourceDir, 'src/index.d.ts'),
    typeScriptConfig: 'tsconfig.json',
  });

  let builds = 0;
  const waitForBuild = async (expected: number) => {
    const deadline = Date.now() + 20_000;
    while (builds < expected && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Give a wrong extra build the time to show up.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(builds).toBe(expected);
  };

  const watch = await compiler.watch({
    nonBlocking: true,
    reportDiagnostics: () => undefined,
    reportWatchStatus: () => undefined,
    compilationComplete: () => builds++,
  });
  try {
    await waitForBuild(1);

    // Not files of the program: no build (nor for the build's own output).
    writeFileSync(join(sourceDir, 'README.md'), '# Changed');
    writeFileSync(join(sourceDir, 'src', 'notes.txt'), 'notes');
    writeFileSync(join(sourceDir, 'other.ts'), 'export class Outside {}');
    await waitForBuild(1);

    // The file the tsconfig extends.
    writeFileSync(join(sourceDir, 'base.json'), base({ noUnusedLocals: true }));
    await waitForBuild(2);

    // A new file of the include patterns.
    writeFileSync(join(sourceDir, 'src', 'added.ts'), 'export class Added {}');
    await waitForBuild(3);
  } finally {
    watch.close();
    rmSync(sourceDir, { force: true, recursive: true });
  }
}, 60_000);
