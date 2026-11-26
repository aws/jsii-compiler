import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as spec from '@jsii/spec';
import { writeAssembly } from '@jsii/spec';
import clone from 'clone';
import * as ts from 'typescript';

import { loadProjectInfo, PackageJson } from '../src/project-info';
import { TypeScriptConfigValidationRuleSet } from '../src/tsconfig';
import { VERSION } from '../src/version';

const BASE_PROJECT = {
  name: 'jsii-test',
  version: '1.0.0',
  description: 'A test project for jsii ProjectInfo loading',
  license: 'Apache-2.0',
  author: {
    name: 'Amazon Web Services',
    url: 'https://aws.amazon.com',
    organization: true,
  },
  repository: { url: 'git://github.com/aws/jsii.git' },
  main: 'index.js',
  types: 'index.d.ts',
  jsii: {
    targets: { python: { module: 'test_module', distName: 'test-dist' } },
  },
  dependencies: { 'jsii-test-dep': '^1.2.3' } as { [name: string]: string },
  peerDependencies: { 'jsii-test-dep': '^1.2.3' } as { [name: string]: string },
} satisfies PackageJson;

describe('loadProjectInfo', () => {
  test('loads valid project', () =>
    _withTestProject((projectRoot) => {
      const { projectInfo: info } = loadProjectInfo(projectRoot);
      expect(info.name).toBe(BASE_PROJECT.name);
      expect(info.version).toBe(BASE_PROJECT.version);
      expect(info.description).toBe(BASE_PROJECT.description);
      expect(info.license).toBe(BASE_PROJECT.license);
      expect(_stripUndefined(info.author)).toEqual({
        ...BASE_PROJECT.author,
        roles: ['author'],
      });
      expect(info.main).toBe(BASE_PROJECT.main);
      expect(info.types).toBe(BASE_PROJECT.types);
      expect(info.homepage).toBe(undefined);
      expect(info.repository?.type).toBe('git');
      expect(info.repository?.url).toBe(BASE_PROJECT.repository.url);
      expect(info.targets).toEqual({
        ...BASE_PROJECT.jsii.targets,
        js: { npm: BASE_PROJECT.name },
      });
      expect(info.dependencies).toEqual({
        [TEST_DEP_ASSEMBLY.name]: BASE_PROJECT.dependencies[TEST_DEP_ASSEMBLY.name],
      });
      expect(info.dependencyClosure).toEqual([TEST_DEP_ASSEMBLY, TEST_DEP_DEP_ASSEMBLY]);
    }));

  test('loads valid project (with zipped assembly)', () =>
    _withTestProject(
      (projectRoot) => {
        const { projectInfo: info } = loadProjectInfo(projectRoot);
        expect(info.name).toBe(BASE_PROJECT.name);
        expect(info.version).toBe(BASE_PROJECT.version);
        expect(info.description).toBe(BASE_PROJECT.description);
        expect(info.license).toBe(BASE_PROJECT.license);
        expect(_stripUndefined(info.author)).toEqual({
          ...BASE_PROJECT.author,
          roles: ['author'],
        });
        expect(info.main).toBe(BASE_PROJECT.main);
        expect(info.types).toBe(BASE_PROJECT.types);
        expect(info.homepage).toBe(undefined);
        expect(info.repository?.type).toBe('git');
        expect(info.repository?.url).toBe(BASE_PROJECT.repository.url);
        expect(info.targets).toEqual({
          ...BASE_PROJECT.jsii.targets,
          js: { npm: BASE_PROJECT.name },
        });
        expect(info.dependencies).toEqual({
          [TEST_DEP_ASSEMBLY.name]: BASE_PROJECT.dependencies[TEST_DEP_ASSEMBLY.name],
        });
        expect(info.dependencyClosure).toEqual([TEST_DEP_ASSEMBLY, TEST_DEP_DEP_ASSEMBLY]);
      },
      undefined,
      true /* compress assembly */,
    ));

  test('loads valid project (UNLICENSED)', () =>
    _withTestProject(
      (projectRoot) => {
        const { projectInfo: info } = loadProjectInfo(projectRoot);
        expect(info?.license).toBe('UNLICENSED');
      },
      (info) => {
        info.license = 'UNLICENSED';
      },
    ));

  test('loads valid project (using bundleDependencies)', () =>
    _withTestProject(
      (projectRoot) => {
        const { projectInfo: info } = loadProjectInfo(projectRoot);
        expect(info.bundleDependencies).toEqual({ bundled: '^1.2.3' });
      },
      (info) => {
        info.dependencies.bundled = '^1.2.3';
        info.bundleDependencies = ['bundled'];
      },
    ));

  test('loads valid project (using bundledDependencies)', () =>
    _withTestProject(
      (projectRoot) => {
        const { projectInfo: info } = loadProjectInfo(projectRoot);
        expect(info.bundleDependencies).toEqual({ bundled: '^1.2.3' });
      },
      (info) => {
        info.dependencies.bundled = '^1.2.3';
        info.bundledDependencies = ['bundled'];
      },
    ));

  test('loads valid project (with contributors)', () => {
    const contributors = [{ name: 'foo', email: 'nobody@amazon.com' }];
    return _withTestProject(
      (projectRoot) => {
        const { projectInfo: info } = loadProjectInfo(projectRoot);
        expect(info?.contributors?.map(_stripUndefined)).toEqual(
          contributors.map((c) => ({ ...c, roles: ['contributor'] })),
        );
      },
      (info) => (info.contributors = contributors),
    );
  });

  test('rejects un-declared dependency in bundleDependencies', () =>
    _withTestProject(
      (projectRoot) => expect(() => loadProjectInfo(projectRoot)).toThrow(/not declared in "dependencies"/i),
      (info) => {
        info.bundledDependencies = ['bundled'];
      },
    ));

  test('rejects invalid license', () =>
    _withTestProject(
      (projectRoot) => expect(() => loadProjectInfo(projectRoot)).toThrow(/invalid license identifier/i),
      (info) => {
        info.license = 'Not an SPDX licence ID';
      },
    ));

  test('rejects incompatible dependency version', () =>
    _withTestProject(
      (projectRoot) =>
        expect(() => loadProjectInfo(projectRoot)).toThrow(
          /declared dependency on version .+ but version .+ was found/i,
        ),
      (info) => {
        info.dependencies[TEST_DEP_ASSEMBLY.name] = '^1.2.5';
        info.peerDependencies[TEST_DEP_ASSEMBLY.name] = '^1.2.5';
      },
    ));

  test('missing peerDependencies are allowed', () =>
    _withTestProject(
      (projectRoot) =>
        expect(loadProjectInfo(projectRoot)).toEqual(
          expect.objectContaining({
            diagnostics: [],
          }),
        ),
      (info) => {
        delete info.peerDependencies[TEST_DEP_ASSEMBLY.name];
      },
    ));

  test('warns if peerDependency misses a matching devDependency', () =>
    _withTestProject(
      (projectRoot) =>
        expect(loadProjectInfo(projectRoot)).toEqual(
          expect.objectContaining({
            diagnostics: [expect.objectContaining({ jsiiCode: 6 })],
          }),
        ),
      () => {
        // By default there is no devDependency in BASE_PROJECT
      },
    ));

  test('warns if peerDependency has a devDependency on the wrong version', () =>
    _withTestProject(
      (projectRoot) =>
        expect(loadProjectInfo(projectRoot)).toEqual(
          expect.objectContaining({
            diagnostics: [expect.objectContaining({ jsiiCode: 6 })],
          }),
        ),
      (info) => {
        // By default there is no devDependency in BASE_PROJECT
        info.devDependencies = { 'jsii-test-dep': '4.5.6' };
      },
    ));

  test('no warnings if devDependency point version matches peerDependency range', () =>
    _withTestProject(
      (projectRoot) =>
        expect(loadProjectInfo(projectRoot)).toEqual(
          expect.objectContaining({
            diagnostics: [],
          }),
        ),
      (info) => {
        // By default there is no devDependency in BASE_PROJECT
        info.devDependencies = { 'jsii-test-dep': '1.2.3' };
      },
    ));

  describe('_loadDiagnostics', () => {
    test('diagnostic categories are correctly detected', () => {
      return _withTestProject(
        (projectRoot) => {
          const { projectInfo: info } = loadProjectInfo(projectRoot);
          expect(info.diagnostics).toBeDefined();
          const diagnostics = info.diagnostics!;
          expect(Object.keys(diagnostics).sort()).toEqual(['diagCode1', 'diagCode2', 'diagCode3', 'diagCode4']);
          expect(diagnostics.diagCode1).toEqual(ts.DiagnosticCategory.Error);
          expect(diagnostics.diagCode2).toEqual(ts.DiagnosticCategory.Warning);
          expect(diagnostics.diagCode3).toEqual(ts.DiagnosticCategory.Suggestion);
          expect(diagnostics.diagCode4).toEqual(ts.DiagnosticCategory.Message);
        },
        (info) => {
          const diagnostics = {
            diagCode1: 'error',
            diagCode2: 'warning',
            diagCode3: 'suggestion',
            diagCode4: 'message',
          } as const;
          info.jsii.diagnostics = diagnostics;
        },
      );
    });

    test('invalid category is rejected', () => {
      return _withTestProject(
        (projectRoot) => expect(() => loadProjectInfo(projectRoot)).toThrow(/Invalid category/),
        (info) => {
          const diagnostics = {
            diagCode1: 'invalid-category',
          } as any;
          info.jsii.diagnostics = diagnostics;
        },
      );
    });
  });

  describe('invalid target configuration', () => {
    test('invalid Go packageName is rejected', () => {
      expectProjectLoadError(/contains non-identifier characters/, (proj) => {
        proj.jsii.targets.go = {
          moduleName: 'asdf',
          packageName: 'as-df',
        };
      });
    });

    test('invalid .NET namespace is rejected', () => {
      expectProjectLoadError(/contains non-identifier characters/, (proj) => {
        proj.jsii.targets.dotnet = {
          namespace: 'a-x',
          packageId: 'asdf',
        };
      });
    });

    test('invalid Java package is rejected', () => {
      expectProjectLoadError(/contains non-identifier characters/, (proj) => {
        proj.jsii.targets.java = {
          package: 'as-df',
          maven: {
            artifactId: 'asdf',
            groupId: 'asdf',
          },
        };
      });
    });

    test('invalid Python module is rejected', () => {
      expectProjectLoadError(/contains non-identifier characters/, (proj) => {
        proj.jsii.targets.python = {
          module: 'as-df',
          distName: 'as-df',
        };
      });
    });

    function expectProjectLoadError(error: RegExp, gremlin: Parameters<typeof _withTestProject>[1]) {
      _withTestProject((root) => expect(() => loadProjectInfo(root)).toThrow(error), gremlin);
    }
  });

  describe('user-provided tsconfig', () => {
    test('can set a user-provided config', () => {
      return _withTestProject(
        (projectRoot) => expect(loadProjectInfo(projectRoot).projectInfo.tsconfig).toBe('tsconfig.dev.json'),
        (info) => {
          info.jsii.tsconfig = 'tsconfig.dev.json';
        },
      );
    });

    test('if user-provided config is not set, default is undefined', () => {
      return _withTestProject(
        (projectRoot) => expect(loadProjectInfo(projectRoot).projectInfo.tsconfig).toBe(undefined),
        (info) => {
          info.jsii.tsconfig = undefined;
        },
      );
    });

    test.each(Object.entries(TypeScriptConfigValidationRuleSet))(
      'can set validation rule: "%s"',
      (key: string, ruleSet: string) => {
        return _withTestProject(
          (projectRoot) =>
            expect(loadProjectInfo(projectRoot).projectInfo.validateTsconfig).toBe(
              TypeScriptConfigValidationRuleSet[key as keyof typeof TypeScriptConfigValidationRuleSet],
            ),
          (info) => {
            info.jsii.validateTsconfig = ruleSet;
          },
        );
      },
    );

    test('if validation rule set is not set, default is strict', () => {
      return _withTestProject(
        (projectRoot) =>
          expect(loadProjectInfo(projectRoot).projectInfo.validateTsconfig).toBe(
            TypeScriptConfigValidationRuleSet.STRICT,
          ),
        (info) => {
          info.jsii.validateTsConfig = undefined;
        },
      );
    });

    test.each([[''], [' '], ['definitely-invalid1234']])(
      'reject invalid validation rule set: "%s"',
      (ruleSet: string) => {
        return _withTestProject(
          (projectRoot) => expect(() => loadProjectInfo(projectRoot)).toThrow(/Invalid validateTsconfig/),
          (info) => {
            info.jsii.validateTsconfig = ruleSet;
          },
        );
      },
    );
  });

  describe('package.json validation', () => {
    test.each(['name', 'version', 'author', 'repository', 'main', 'jsii'] as const)(
      'rejects a missing "%s" attribute',
      (attribute) =>
        _withTestProject(
          (projectRoot) =>
            expect(() => loadProjectInfo(projectRoot)).toThrow(
              `The "package.json" file must specify the "${attribute}" attribute`,
            ),
          (info) => {
            delete (info as any)[attribute];
          },
        ),
    );

    test('rejects a missing license', () =>
      _withTestProject(
        (projectRoot) => expect(() => loadProjectInfo(projectRoot)).toThrow(/No "license" was specified/),
        (info) => {
          delete (info as any).license;
        },
      ));

    test('rejects a "repository" without a URL', () =>
      _withTestProject(
        (projectRoot) =>
          expect(() => loadProjectInfo(projectRoot)).toThrow('must specify the "repository.url" attribute'),
        (info) => {
          (info as any).repository = { type: 'git' };
        },
      ));

    test('rejects an author without a name', () =>
      _withTestProject(
        (projectRoot) => expect(() => loadProjectInfo(projectRoot)).toThrow('must specify the "author.name" attribute'),
        (info) => {
          (info as any).author = { url: 'https://aws.amazon.com' };
        },
      ));

    test('accepts "author" and "repository" in their string forms', () =>
      _withTestProject(
        (projectRoot) => {
          const { projectInfo } = loadProjectInfo(projectRoot);
          expect(_stripUndefined(projectInfo.author)).toEqual({
            name: 'Jane Doe',
            email: 'jane@example.com',
            url: 'https://example.com',
            roles: ['author'],
          });
          expect(_stripUndefined(projectInfo.repository)).toEqual({
            type: 'git',
            url: 'https://github.com/aws/jsii-compiler.git',
          });
        },
        (info) => {
          (info as any).author = 'Jane Doe <jane@example.com> (https://example.com)';
          (info as any).repository = 'aws/jsii-compiler';
        },
      ));

    test('rejects a malformed "author" string', () =>
      _withTestProject(
        (projectRoot) => expect(() => loadProjectInfo(projectRoot)).toThrow(/Invalid stringified "person" value/),
        (info) => {
          (info as any).author = '';
        },
      ));

    describe('repository type', () => {
      test('is guessed from the URL scheme when absent', () =>
        _withTestProject(
          (projectRoot) => expect(loadProjectInfo(projectRoot).projectInfo.repository?.type).toBe('svn'),
          (info) => {
            (info as any).repository = { url: 'svn://example.com/repo' };
          },
        ));

      test('is "git" when the URL ends in ".git"', () =>
        _withTestProject(
          (projectRoot) => expect(loadProjectInfo(projectRoot).projectInfo.repository?.type).toBe('git'),
          (info) => {
            (info as any).repository = { url: 'https://example.com/repo.git' };
          },
        ));

      test.each(['http', 'https'])('cannot be guessed from a plain %s URL', (scheme) =>
        _withTestProject(
          (projectRoot) =>
            expect(() => loadProjectInfo(projectRoot)).toThrow(/must specify the "repository.type" attribute/),
          (info) => {
            (info as any).repository = { url: `${scheme}://example.com/repo` };
          },
        ),
      );
    });

    describe('stability', () => {
      test('is "deprecated" when only "deprecated" is set', () =>
        _withTestProject(
          (projectRoot) => expect(loadProjectInfo(projectRoot).projectInfo.stability).toBe('deprecated'),
          (info) => {
            (info as any).deprecated = 'use something else';
          },
        ));

      test('warns when "deprecated" is set but the stability is not "deprecated"', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        _withTestProject(
          (projectRoot) => expect(loadProjectInfo(projectRoot).projectInfo.stability).toBe('stable'),
          (info) => {
            (info as any).deprecated = 'use something else';
            (info as any).stability = 'stable';
          },
        );
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Package is deprecated (use something else)'));
      });

      test('rejects an unknown stability', () =>
        _withTestProject(
          (projectRoot) => expect(() => loadProjectInfo(projectRoot)).toThrow(/Invalid stability "rock-solid"/),
          (info) => {
            (info as any).stability = 'rock-solid';
          },
        ));

      test('is undefined when neither "stability" nor "deprecated" is set', () =>
        _withTestProject((projectRoot) => expect(loadProjectInfo(projectRoot).projectInfo.stability).toBeUndefined()));
    });

    describe('jsii.versionFormat', () => {
      test('rejects an unknown format', () =>
        _withTestProject(
          (projectRoot) => expect(() => loadProjectInfo(projectRoot)).toThrow(/Invalid jsii.versionFormat "long"/),
          (info) => {
            (info.jsii as any).versionFormat = 'long';
          },
        ));

      test('defaults to "full"', () =>
        _withTestProject((projectRoot) =>
          expect(loadProjectInfo(projectRoot).projectInfo.jsiiVersionFormat).toBe('full'),
        ));
    });

    test('rejects an invalid jsii.validateTsconfig rule set', () =>
      _withTestProject(
        (projectRoot) => expect(() => loadProjectInfo(projectRoot)).toThrow(/Invalid validateTsconfig "paranoid"/),
        (info) => {
          (info.jsii as any).validateTsconfig = 'paranoid';
        },
      ));
  });

  describe('dependencies', () => {
    test('rejects a bundled dependency that is also a peer dependency', () =>
      _withTestProject(
        (projectRoot) =>
          expect(() => loadProjectInfo(projectRoot)).toThrow(
            `The "package.json" file has "${TEST_DEP_ASSEMBLY.name}" in "bundleDependencies", and also in "peerDependencies"`,
          ),
        (info) => {
          info.bundleDependencies = [TEST_DEP_ASSEMBLY.name];
        },
      ));

    test('rejects a dependency for which no jsii assembly can be found', () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      _withTestProject(
        (projectRoot) =>
          expect(() => loadProjectInfo(projectRoot)).toThrow(/Unable to locate jsii assembly for "not-installed"/),
        (info) => {
          info.dependencies['not-installed'] = '^1.0.0';
        },
      );
    });

    describe('local "file:" dependencies', () => {
      // This documents current behavior, see https://github.com/aws/jsii-compiler/issues/2946
      test('are found, but fail the version check against the raw "file:" declaration', () =>
        _withTestProject(
          (projectRoot) => {
            const localPackage = path.join(projectRoot, '..', path.basename(projectRoot) + '-local');
            fs.mkdirSync(localPackage, { recursive: true });
            try {
              writeNpmPackageSkeleton(localPackage);
              fs.writeFileSync(
                path.join(localPackage, 'package.json'),
                JSON.stringify({ name: 'jsii-test-local', version: '1.2.3' }),
              );
              writeAssembly(localPackage, {
                ...TEST_DEP_ASSEMBLY,
                name: 'jsii-test-local',
                version: '1.2.3',
                dependencies: undefined,
              });

              const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
              const reference = `file:../${path.basename(localPackage)}`;
              pkg.dependencies = { 'jsii-test-local': reference };
              pkg.peerDependencies = { 'jsii-test-local': reference };
              fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify(pkg));

              expect(() => loadProjectInfo(projectRoot)).toThrow(
                /Declared dependency on version file:\.\.\/.+-local of jsii-test-local, but version 1\.2\.3 was found/,
              );
            } finally {
              fs.rmSync(localPackage, { force: true, recursive: true });
            }
          },
          (info) => {
            info.dependencies = {};
            info.peerDependencies = {};
          },
        ));

      test('are rejected when the local package has no assembly', () =>
        _withTestProject(
          (projectRoot) => {
            const localPackage = path.join(projectRoot, 'local-without-assembly');
            fs.mkdirSync(localPackage, { recursive: true });
            fs.writeFileSync(
              path.join(localPackage, 'package.json'),
              JSON.stringify({ name: 'jsii-test-local', version: '1.2.3' }),
            );

            expect(() => loadProjectInfo(projectRoot)).toThrow(
              /Expected to find .jsii file in .*local-without-assembly/,
            );
          },
          (info) => {
            info.dependencies = { 'jsii-test-local': 'file:./local-without-assembly' };
            info.peerDependencies = {};
          },
        ));
    });
  });
});

const TEST_DEP_ASSEMBLY: spec.Assembly = {
  schema: spec.SchemaVersion.LATEST,
  name: 'jsii-test-dep',
  version: '1.2.4',
  license: 'Apache-2.0',
  description: 'A jsii dependency of jsii-test',
  homepage: 'https://github.com/aws/jsii',
  repository: { type: 'git', url: 'git://github.com/aws/jsii.git' },
  author: {
    name: 'Amazon Web Services',
    url: 'https://aws.amazon.com',
    organization: true,
    roles: ['author'],
  },
  fingerprint: 'F1NG3RPR1N7',
  dependencies: {
    'jsii-test-dep-dep': '3.2.1',
  },
  jsiiVersion: VERSION,
};

const TEST_DEP_DEP_ASSEMBLY: spec.Assembly = {
  schema: spec.SchemaVersion.LATEST,
  name: 'jsii-test-dep-dep',
  version: '3.2.1',
  license: 'Apache-2.0',
  description: 'A jsii dependency of jsii-test-dep',
  homepage: 'https://github.com/aws/jsii',
  repository: { type: 'git', url: 'git://github.com/aws/jsii.git' },
  author: {
    name: 'Amazon Web Services',
    url: 'https://aws.amazon.com',
    organization: true,
    roles: ['author'],
  },
  jsiiVersion: VERSION,
  fingerprint: 'F1NG3RPR1N7',
};

/**
 * A type to represent the package.json type that gets mutated by testproject gremlins
 */
type HalfFilledPackageJson = DeepWriteable<PackageJson> & typeof BASE_PROJECT;

/**
 * Creates a throw-away directory with a ``package.json`` file. Cleans up after itself.
 *
 * @param cb      a callback that will be invoked with the temporary directory's path
 * @param gremlin a function that can modify the content of ``package.json`` before it is written
 *
 * @return the result of executing ``cb``.
 */
function _withTestProject<T>(
  cb: (projectRoot: string) => T,
  gremlin?: (packageInfo: HalfFilledPackageJson) => void,
  compressAssembly = false,
): T {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), path.basename(__filename)));
  try {
    const packageInfo = clone(BASE_PROJECT);
    if (gremlin) {
      gremlin(packageInfo);
    }
    fs.writeFileSync(path.join(tmpdir, 'package.json'), JSON.stringify(packageInfo, null, 2), 'utf-8');
    fs.writeFileSync(path.join(tmpdir, 'index.js'), '// There ought to be some javascript');
    fs.writeFileSync(path.join(tmpdir, 'index.ts'), '// There ought to be some typescript');
    fs.writeFileSync(path.join(tmpdir, 'index.d.ts'), '// There ought to be some typescript definitions');

    const jsiiTestDep = path.join(tmpdir, 'node_modules', 'jsii-test-dep');
    writeNpmPackageSkeleton(jsiiTestDep);

    writeAssembly(jsiiTestDep, TEST_DEP_ASSEMBLY, {
      compress: compressAssembly,
    });
    const jsiiTestDepDep = path.join(jsiiTestDep, 'node_modules', 'jsii-test-dep-dep');

    writeNpmPackageSkeleton(jsiiTestDepDep);
    writeAssembly(jsiiTestDepDep, TEST_DEP_DEP_ASSEMBLY, {
      compress: compressAssembly,
    });

    return cb(tmpdir);
  } finally {
    fs.rmSync(tmpdir, { force: true, recursive: true });
  }
}

/**
 * Write a package.json and an index.js so the package is mostly well-formed
 */
function writeNpmPackageSkeleton(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: path.basename(directory),
    }),
    'utf-8',
  );
  fs.writeFileSync(path.join(directory, 'index.js'), '// There should be some JS');
}

/**
 * Removes keys from an object if the associated value is ``undefined``.
 *
 * @param obj the object to be stripped.
 *
 * @return ``obj`` after it has been stripped.
 */
function _stripUndefined(obj: { [key: string]: any } | undefined): { [key: string]: any } | undefined {
  if (!obj) {
    return obj;
  }
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) {
      delete obj[key];
    }
  }
  return obj;
}

type DeepWriteable<T> = T extends object ? { -readonly [P in keyof T]: DeepWriteable<T[P]> } : T;
