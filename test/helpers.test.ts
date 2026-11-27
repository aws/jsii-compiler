import * as fs from 'node:fs';

import { compileJsiiForTest, normalizeConfigPath, sourceToAssemblyHelper, TestWorkspace } from '../src';

describe('sourceToAssemblyHelper', () => {
  test('returns the assembly of the compiled source', () => {
    const assembly = sourceToAssemblyHelper('export class Klass {}');

    expect(Object.keys(assembly.types ?? {})).toEqual(['testpkg.Klass']);
  });

  test('accepts a callback to modify the package.json', () => {
    const assembly = sourceToAssemblyHelper('export class Klass {}', (pkg) => {
      pkg.name = 'renamed';
    });

    expect(assembly.name).toBe('renamed');
    expect(Object.keys(assembly.types ?? {})).toEqual(['renamed.Klass']);
  });

  test('fails when compilation fails and diagnostics are captured', () => {
    expect(() => sourceToAssemblyHelper('export class Klass extends Missing {}', { captureDiagnostics: true })).toThrow(
      'Compilation failed',
    );
  });
});

describe('compileJsiiForTest', () => {
  test('logs errors to the console and throws when diagnostics are not captured', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => compileJsiiForTest('export class Klass extends Missing {}')).toThrow('There were compiler errors');
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("Cannot find name 'Missing'"));
    } finally {
      consoleError.mockRestore();
    }
  });

  test('returns a failure with the diagnostics when they are captured', () => {
    const result = compileJsiiForTest('export class Klass extends Missing {}', { captureDiagnostics: true });

    expect(result.type).toBe('failure');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ messageText: "Cannot find name 'Missing'." }));
  });

  test('returns the generated files, including those under the configured outDir', () => {
    const result = compileJsiiForTest('export class Klass {}', {
      packageJson: {
        main: 'lib/index.js',
        types: 'lib/index.d.ts',
        jsii: { tsc: { outDir: 'lib', rootDir: '.' } },
      },
    });

    expect(Object.keys(result.files).sort()).toEqual(['lib/index.d.ts', 'lib/index.js']);
  });

  test('compiles in the requested directory and marks the assembly as compressed on request', () => {
    TestWorkspace.withWorkspace((workspace) => {
      const result = compileJsiiForTest('export class Klass {}', {
        compilationDirectory: workspace.rootDirectory,
        compressAssembly: true,
      });

      expect(result.compressAssembly).toBe(true);
      expect(fs.existsSync(`${workspace.rootDirectory}/.jsii`)).toBe(true);
    });
  });
});

describe('TestWorkspace', () => {
  test('refuses to add a dependency that failed to compile', () =>
    TestWorkspace.withWorkspace((workspace) => {
      const failure = compileJsiiForTest('export class Klass extends Missing {}', { captureDiagnostics: true });

      expect(() => workspace.addDependency(failure)).toThrow('Cannot add dependency: assembly compilation failed');
    }));

  test('refuses to add the same dependency twice', () =>
    TestWorkspace.withWorkspace((workspace) => {
      const dependency = compileJsiiForTest('export class Klass {}', { packageJson: { name: 'dependency' } });
      workspace.addDependency(dependency);

      expect(() => workspace.addDependency(dependency)).toThrow(
        "A dependency with name 'dependency' was already installed. Give one a different name.",
      );
    }));

  test('locates the directory of an installed dependency', () =>
    TestWorkspace.withWorkspace((workspace) => {
      workspace.addDependency(compileJsiiForTest('export class Klass {}', { packageJson: { name: 'dependency' } }));

      expect(workspace.dependencyDir('dependency')).toBe(`${workspace.rootDirectory}/node_modules/dependency`);
    }));

  test('fails to locate a dependency that was not installed', () =>
    TestWorkspace.withWorkspace((workspace) => {
      expect(() => workspace.dependencyDir('missing')).toThrow("No dependency with name 'missing' has been installed");
    }));

  test('cleans up its root directory', () => {
    const workspace = TestWorkspace.create();
    expect(fs.existsSync(workspace.rootDirectory)).toBe(true);

    workspace.cleanup();

    expect(fs.existsSync(workspace.rootDirectory)).toBe(false);
  });

  test('withWorkspace cleans up even when the block throws', () => {
    let rootDirectory: string | undefined;

    expect(() =>
      TestWorkspace.withWorkspace((workspace) => {
        rootDirectory = workspace.rootDirectory;
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(fs.existsSync(rootDirectory!)).toBe(false);
  });
});

describe('normalizeConfigPath', () => {
  test('keeps undefined and relative paths as they are', () => {
    expect(normalizeConfigPath('/project', undefined)).toBeUndefined();
    expect(normalizeConfigPath('/project', 'lib')).toBe('lib');
  });

  test('makes absolute paths relative to the root', () => {
    expect(normalizeConfigPath('/project', '/project/lib/sub')).toBe('lib/sub');
  });
});
