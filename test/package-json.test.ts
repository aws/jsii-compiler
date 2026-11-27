import * as fs from 'node:fs';
import * as path from 'node:path';
import { compileJsiiForTest, TestWorkspace } from '../src';
import { captureOutput } from './output-helpers';

/**
 * The compiler reads the project's `package.json` before it compiles anything. These tests compile a small project
 * with a modified `package.json` and check what comes out (or the error the user gets).
 */

type Overrides = Record<string, unknown>;

/**
 * Compiles a trivial project in a fresh workspace, with `overrides` merged into the default `package.json`.
 * An override with the value `undefined` removes the attribute.
 */
function compileWith(overrides: Overrides, prepare?: (ws: TestWorkspace) => void) {
  return TestWorkspace.withWorkspace((ws) => {
    prepare?.(ws);
    return compileJsiiForTest('export class Klass {}', {
      compilationDirectory: ws.rootDirectory,
      packageJson: overrides as any,
    });
  });
}

const DEPENDS_ON_IT = { dependencies: { dependency: '*' }, peerDependencies: { dependency: '*' } };

function installDependency(ws: TestWorkspace) {
  ws.addDependency(compileJsiiForTest('export class Foreign {}', { packageJson: { name: 'dependency' } }));
}

describe('package.json validation', () => {
  test.each(['name', 'version', 'author', 'repository', 'main', 'jsii'])(
    'rejects a missing "%s" attribute',
    (attribute) => {
      expect(() => compileWith({ [attribute]: undefined })).toThrow(
        `The "package.json" file must specify the "${attribute}" attribute`,
      );
    },
  );

  test('rejects a missing license', () => {
    expect(() => compileWith({ license: undefined })).toThrow(/No "license" was specified/);
  });

  test('accepts the license "UNLICENSED"', () => {
    expect(compileWith({ license: 'UNLICENSED' }).assembly.license).toBe('UNLICENSED');
  });

  test('rejects a "repository" without a URL', () => {
    expect(() => compileWith({ repository: { type: 'git' } })).toThrow('must specify the "repository.url" attribute');
  });

  test('rejects an author without a name', () => {
    expect(() => compileWith({ author: { url: 'https://aws.amazon.com' } })).toThrow(
      'must specify the "author.name" attribute',
    );
  });

  test('accepts "author" and "repository" in their string forms', () => {
    const { assembly } = compileWith({
      author: 'Jane Doe <jane@example.com> (https://example.com)',
      repository: 'aws/jsii-compiler',
    });

    expect(assembly.author).toEqual({
      name: 'Jane Doe',
      email: 'jane@example.com',
      url: 'https://example.com',
      roles: ['author'],
    });
    expect(assembly.repository).toEqual({ type: 'git', url: 'https://github.com/aws/jsii-compiler.git' });
  });

  test('rejects a malformed "author" string', () => {
    expect(() => compileWith({ author: '' })).toThrow(/Invalid stringified "person" value/);
  });

  test('keeps contributors, with the role "contributor"', () => {
    const { assembly } = compileWith({ contributors: [{ name: 'foo', email: 'nobody@amazon.com' }] });

    expect(assembly.contributors).toEqual([{ name: 'foo', email: 'nobody@amazon.com', roles: ['contributor'] }]);
  });

  describe('repository type', () => {
    test('is guessed from the URL scheme when absent', () => {
      expect(compileWith({ repository: { url: 'svn://example.com/repo' } }).assembly.repository?.type).toBe('svn');
    });

    test('is "git" when the URL ends in ".git"', () => {
      expect(compileWith({ repository: { url: 'https://example.com/repo.git' } }).assembly.repository?.type).toBe(
        'git',
      );
    });

    test.each(['http', 'https'])('cannot be guessed from a plain %s URL', (scheme) => {
      expect(() => compileWith({ repository: { url: `${scheme}://example.com/repo` } })).toThrow(
        /must specify the "repository.type" attribute/,
      );
    });
  });

  describe('stability', () => {
    test('is "deprecated" when only "deprecated" is set', () => {
      expect(compileWith({ deprecated: 'use something else' }).assembly.docs?.stability).toBe('deprecated');
    });

    test('warns when "deprecated" is set but the stability is not "deprecated"', () => {
      const { result, output } = captureOutput(
        () => compileWith({ deprecated: 'use something else', stability: 'stable' }),
        'warn',
      );

      expect(result.assembly.docs?.stability).toBe('stable');
      expect(output).toContain('Package is deprecated (use something else)');
    });

    test('rejects an unknown stability', () => {
      expect(() => compileWith({ stability: 'rock-solid' })).toThrow(/Invalid stability "rock-solid"/);
    });

    test('is not set when neither "stability" nor "deprecated" is set', () => {
      expect(compileWith({}).assembly.docs?.stability).toBeUndefined();
    });
  });

  describe('jsii.versionFormat', () => {
    test('rejects an unknown format', () => {
      expect(() => compileWith({ jsii: { versionFormat: 'long' } })).toThrow(/Invalid jsii.versionFormat "long"/);
    });
  });

  test('rejects an invalid jsii.validateTsconfig rule set', () => {
    expect(() => compileWith({ jsii: { validateTsconfig: 'paranoid' } })).toThrow(
      /Invalid validateTsconfig "paranoid"/,
    );
  });
});

describe('dependencies', () => {
  test('are recorded in the assembly, with their own dependencies', () => {
    const { assembly } = compileWith(DEPENDS_ON_IT, installDependency);

    expect(assembly.dependencies).toEqual({ dependency: '*' });
    expect(assembly.dependencyClosure).toEqual({ dependency: { targets: { js: { npm: 'dependency' } } } });
  });

  test.each(['bundleDependencies', 'bundledDependencies'])('can be bundled with "%s"', (attribute) => {
    const { assembly } = compileWith(
      { dependencies: { dependency: '*' }, [attribute]: ['dependency'] },
      installDependency,
    );

    expect(assembly.bundled).toEqual({ dependency: '*' });
  });

  test('rejects an un-declared dependency in bundleDependencies', () => {
    expect(() => compileWith({ bundleDependencies: ['dependency'] }, installDependency)).toThrow(
      /not declared in "dependencies"/i,
    );
  });

  test('rejects a bundled dependency that is also a peer dependency', () => {
    expect(() => compileWith({ ...DEPENDS_ON_IT, bundleDependencies: ['dependency'] }, installDependency)).toThrow(
      'has "dependency" in "bundleDependencies", and also in "peerDependencies"',
    );
  });

  test('rejects a dependency for which no jsii assembly can be found', () => {
    expect(() =>
      compileWith({ dependencies: { 'not-installed': '^1.0.0' }, peerDependencies: { 'not-installed': '^1.0.0' } }),
    ).toThrow(/Unable to locate jsii assembly for "not-installed"/);
  });

  describe('local "file:" dependencies', () => {
    function withLocalPackage(ws: TestWorkspace, assembly: boolean) {
      const dependency = compileJsiiForTest('export class Foreign {}', { packageJson: { name: 'jsii-test-local' } });
      const dir = path.join(ws.rootDirectory, 'local');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'jsii-test-local', version: '1.2.3' }));
      if (assembly) {
        fs.writeFileSync(path.join(dir, '.jsii'), JSON.stringify({ ...dependency.assembly, version: '1.2.3' }));
      }
    }
    const LOCAL = { 'jsii-test-local': 'file:./local' };

    // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2946
    test('are found, but fail the version check against the raw "file:" declaration', () => {
      expect(() =>
        compileWith({ dependencies: LOCAL, peerDependencies: LOCAL }, (ws) => withLocalPackage(ws, true)),
      ).toThrow(/Declared dependency on version file:\.\/local of jsii-test-local, but version 1\.2\.3 was found/);
    });

    test('are rejected when the local package has no assembly', () => {
      expect(() =>
        compileWith({ dependencies: LOCAL, peerDependencies: LOCAL }, (ws) => withLocalPackage(ws, false)),
      ).toThrow(/Expected to find .jsii file in .*local/);
    });
  });
});
