import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileJsiiForTest } from '../../src/helpers';

const SOURCE = 'export class Klass {}';

function compile(
  packageJson: Record<string, unknown>,
  source: string | { 'index.ts': string; [file: string]: string } = SOURCE,
) {
  return compileJsiiForTest(source, { packageJson: packageJson as any });
}

describe('package.json fields that end up in the assembly', () => {
  test('name, version, license, author and repository are copied', () => {
    const { assembly } = compile({ name: 'my-lib', version: '1.2.3', license: 'MIT' });

    expect(assembly).toMatchObject({
      name: 'my-lib',
      version: '1.2.3',
      license: 'MIT',
      author: { name: 'John Doe', roles: ['author'] },
      repository: { type: 'git', url: 'https://github.com/aws/jsii.git' },
    });
  });

  test('the description is used, and defaults to the package name', () => {
    expect(compile({ description: 'Does things' }).assembly.description).toBe('Does things');
    expect(compile({}).assembly.description).toBe('testpkg');
  });

  test('the homepage is used, and defaults to the repository URL', () => {
    expect(compile({ homepage: 'https://example.com' }).assembly.homepage).toBe('https://example.com');
    expect(compile({}).assembly.homepage).toBe('https://github.com/aws/jsii.git');
  });

  test('keywords are copied, and absent when not set', () => {
    expect(compile({ keywords: ['a', 'b'] }).assembly.keywords).toEqual(['a', 'b']);
    expect(compile({}).assembly.keywords).toBeUndefined();
  });

  test('bin is copied, and absent when not set', () => {
    expect(compile({ bin: { tool: 'bin/tool' } }).assembly.bin).toEqual({ tool: 'bin/tool' });
    expect(compile({}).assembly.bin).toBeUndefined();
  });

  test('the npm package is always a target, next to the targets of jsii.targets', () => {
    const { assembly } = compile({ jsii: { targets: { python: { distName: 'my-lib', module: 'my_lib' } } } });

    expect(assembly.targets).toEqual({
      js: { npm: 'testpkg' },
      python: { distName: 'my-lib', module: 'my_lib' },
    });
  });

  test('"deprecated" and "stability" become the stability of the assembly', () => {
    expect(compile({ stability: 'experimental' }).assembly.docs).toEqual({ stability: 'experimental' });
    expect(compile({ deprecated: 'Use another package' }).assembly.docs).toEqual({
      stability: 'deprecated',
      deprecated: 'Use another package',
    });
  });

  test('the types in a package inherit the stability of the package', () => {
    const { assembly } = compile({ stability: 'experimental' });

    expect(assembly.types!['testpkg.Klass'].docs).toEqual({ stability: 'experimental' });
  });
});

describe('jsii.metadata', () => {
  test('is copied to the assembly, next to the metadata that jsii adds', () => {
    const { assembly } = compile({ jsii: { metadata: { custom: { answer: 42 } } } });

    expect(assembly.metadata).toMatchObject({
      custom: { answer: 42 },
      jsii: { pacmak: { hasDefaultInterfaces: true } },
    });
  });

  test('can add to, and override, the metadata that jsii adds', () => {
    const { assembly } = compile({
      jsii: { metadata: { jsii: { pacmak: { hasDefaultInterfaces: false }, other: 1 } } },
    });

    expect(assembly.metadata?.jsii).toEqual({ pacmak: { hasDefaultInterfaces: false }, other: 1 });
  });
});

describe('jsii.versionFormat', () => {
  test('"full" includes the build of the compiler, and is the default', () => {
    expect(compile({}).assembly.jsiiVersion).toMatch(/^\S+ \(build \w+/);
    expect(compile({ jsii: { versionFormat: 'full' } }).assembly.jsiiVersion).toMatch(/^\S+ \(build \w+/);
  });

  test('"short" is only the version of the compiler', () => {
    expect(compile({ jsii: { versionFormat: 'short' } }).assembly.jsiiVersion).toMatch(/^\d+\.\d+\.\d+\S*$/);
  });
});

describe('jsii.excludeTypescript', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsii-exclude-'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'broken.ts'), 'export const value: string = 12;');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const compileInDir = (jsii: Record<string, unknown>) =>
    compileJsiiForTest(SOURCE, { compilationDirectory: dir, captureDiagnostics: true, packageJson: { jsii } as any });

  test('without it, every TypeScript file of the project is compiled', () => {
    expect(compileInDir({}).type).toBe('failure');
  });

  test('files that match a pattern are left out of the compilation', () => {
    const result = compileInDir({ excludeTypescript: ['scripts/**'] });

    expect(result.type).toBe('success');
  });
});

describe('jsii.tsc', () => {
  test('noImplicitOverride is passed to TypeScript', () => {
    const source =
      'export class Base { public run(): void {} }\nexport class Derived extends Base { public run(): void {} }';

    expect(
      compileJsiiForTest(source, {
        captureDiagnostics: true,
        packageJson: { jsii: { tsc: { noImplicitOverride: true } } } as any,
      }).type,
    ).toBe('failure');
    expect(compile({ jsii: { tsc: { noImplicitOverride: false } } }, source).assembly.types).toHaveProperty([
      'testpkg.Derived',
    ]);
  });
});
