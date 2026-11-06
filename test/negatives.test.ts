import * as fs from 'node:fs';
import * as path from 'node:path';

import { DiagnosticCategory } from '../src/diagnostic';
import { Compiler } from '../src/compiler';
import { ProjectInfo } from '../src/project-info';
import { formatDiagnostic } from '../src/utils';

const SOURCE_DIR = path.join(__dirname, 'negatives');

expect.addSnapshotSerializer({
  test: (val) => typeof val === 'string',
  serialize: (val: string) => val,
});

for (const source of fs.readdirSync(SOURCE_DIR)) {
  if (!source.startsWith('neg.') || !source.endsWith('.ts') || source.endsWith('.d.ts')) {
    continue;
  }
  const filePath = path.join(SOURCE_DIR, source);
  // TODO(ts7): all negatives except the plain TypeScript compilation error expect jsii validation diagnostics
  // (the classic validator), which are not ported to the TypeScript 7 assembler yet; re-enable with that port.
  const testOrSkip = source === 'neg.compilation-error.ts' ? test : test.skip;
  testOrSkip(
    source.replace(/neg\.(.+)\.ts/, '$1'),
    () => {
      const { strict, stripDeprecated } = _getPragmas(filePath);

      // Change in dir, so relative paths are processed correctly.
      process.chdir(SOURCE_DIR);

      const compiler = new Compiler({
        projectInfo: _makeProjectInfo(source),
        failOnWarnings: strict,
        stripDeprecated,
      });
      const emitResult = compiler.emit(path.join(SOURCE_DIR, source));

      expect(emitResult.emitSkipped).toBeTruthy();

      const diagnostics = emitResult.diagnostics
        .filter(
          // Remove suggestion diagnostics, we don't care much for those for now...
          (diag) => diag.category !== DiagnosticCategory.Suggestion,
        )
        .map((diag) => formatDiagnostic(diag, SOURCE_DIR))
        .sort();

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics
          // Remove ANSI color codes from the message so it's nicer in the snapshots file
          // eslint-disable-next-line no-control-regex
          .map((diag) => diag.replace(/\x1B\[[0-9;]*[a-z]/gi, ''))
          .join(''),
      ).toMatchSnapshot();

      // Cleaning up...
      for (const file of fs.readdirSync(SOURCE_DIR)) {
        if (file.startsWith('neg.') && (file.endsWith('.d.ts') || file.endsWith('.js'))) {
          fs.rmSync(path.join(SOURCE_DIR, file), {
            force: true,
            recursive: true,
          });
        }
        fs.rmSync(path.join(SOURCE_DIR, '.jsii'), {
          force: true,
          recursive: true,
        });
        fs.rmSync(path.join(SOURCE_DIR, 'tsconfig.json'), {
          force: true,
          recursive: true,
        });
        fs.rmSync(path.join(SOURCE_DIR, '.build'), {
          force: true,
          recursive: true,
        });
      }
    },
    50000,
  );
}

const STRICT_MARKER = '///!STRICT!';
const STRIP_DEPRECATED_MARKER = '///!STRIP_DEPRECATED!';
function _getPragmas(file: string): {
  strict: boolean;
  stripDeprecated: boolean;
} {
  const data = fs.readFileSync(file, { encoding: 'utf8' });
  const lines = data.split('\n');
  const strict = lines.some((line) => line.startsWith(STRICT_MARKER));
  const stripDeprecated = lines.some((line) => line.startsWith(STRIP_DEPRECATED_MARKER));
  return { strict, stripDeprecated };
}

function _makeProjectInfo(types: string): ProjectInfo {
  const outDir = '.build';
  return {
    projectRoot: SOURCE_DIR,
    packageJson: {},
    types: path.join(outDir, types.replace(/\.d\.ts(x?)/, '.d.ts$1')),
    main: path.join(outDir, types.replace(/(?:\.d)?\.ts(x?)/, '.js$1')),
    name: 'jsii', // That's what package.json would tell if we look up...
    version: '0.0.1',
    jsiiVersionFormat: 'short',
    license: 'Apache-2.0',
    author: { name: 'John Doe', roles: ['author'] },
    repository: { type: 'git', url: 'https://github.com/aws/jsii.git' },
    dependencies: {},
    peerDependencies: {},
    dependencyClosure: [],
    bundleDependencies: {},
    targets: {},
    excludeTypescript: [],
    tsc: {
      outDir,
      types: ['node'],
    },
  };
}
