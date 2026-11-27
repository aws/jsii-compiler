import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';

import { compileJsiiForTest, normalizePath, symbolIdentifier } from '../../src';

let tmpDir: string;

beforeEach(() => {
  // realpath, because TypeScript reports canonical paths
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsii-symbol-id-')));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface Project {
  readonly checker: ts.TypeChecker;
  readonly program: ts.Program;
  readonly sources: Record<string, ts.SourceFile>;
}

/**
 * Write the given files into the temporary directory and create a TypeScript program for them.
 */
function createProject(files: Record<string, string>): Project {
  const names = Object.keys(files).map((name) => {
    const fullPath = path.join(tmpDir, name);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, files[name]);
    return fullPath;
  });

  const program = ts.createProgram(
    names.filter((n) => n.endsWith('.ts')),
    { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, noLib: true, types: [] },
  );
  const sources = Object.fromEntries(names.map((n) => [path.relative(tmpDir, n), program.getSourceFile(n)!]));
  return { checker: program.getTypeChecker(), program, sources };
}

function symbolOf(project: Project, file: string, name: string): ts.Symbol {
  const exports = project.checker.getExportsOfModule(project.checker.getSymbolAtLocation(project.sources[file])!);
  return exports.find((s) => s.name === name)!;
}

describe('symbolIdentifier', () => {
  test('returns undefined without a symbol', () => {
    const project = createProject({ 'package.json': '{}', 'index.ts': 'export class Foo {}' });

    expect(symbolIdentifier(project.checker, undefined)).toBeUndefined();
  });

  test('identifies a type by its source file and name', () => {
    const project = createProject({ 'package.json': '{}', 'lib/index.ts': 'export class Foo {}' });

    expect(symbolIdentifier(project.checker, symbolOf(project, 'lib/index.ts', 'Foo'))).toBe('lib/index:Foo');
  });

  test('identifies members with a # separator', () => {
    const project = createProject({
      'package.json': '{}',
      'index.ts': 'export class Foo { public bar(): void {} public baz = 1; }\nexport enum Color { Red }',
    });
    const foo = symbolOf(project, 'index.ts', 'Foo');
    const color = symbolOf(project, 'index.ts', 'Color');

    expect(symbolIdentifier(project.checker, foo.members!.get('bar' as ts.__String))).toBe('index:Foo#bar');
    expect(symbolIdentifier(project.checker, foo.members!.get('baz' as ts.__String))).toBe('index:Foo#baz');
    expect(symbolIdentifier(project.checker, color.exports!.get('Red' as ts.__String))).toBe('index:Color#Red');
  });

  test('resolves aliases to the symbol they refer to', () => {
    const project = createProject({
      'package.json': '{}',
      'original.ts': 'export class Original {}',
      'index.ts': 'export { Original as Renamed } from "./original";',
    });

    const alias = symbolOf(project, 'index.ts', 'Renamed');
    // eslint-disable-next-line no-bitwise
    expect(alias.flags & ts.SymbolFlags.Alias).not.toBe(0);
    expect(symbolIdentifier(project.checker, alias)).toBe('original:Original');
  });

  test('returns undefined when the symbol does not have a module-qualified name', () => {
    const project = createProject({
      'package.json': '{}',
      'index.ts': 'export function f() { class Local {} return Local; }',
    });
    const fn = project.sources['index.ts'].statements[0] as ts.FunctionDeclaration;
    const localClass = fn.body!.statements[0] as ts.ClassDeclaration;
    const sym = project.checker.getSymbolAtLocation(localClass.name!)!;

    expect(symbolIdentifier(project.checker, sym)).toBeUndefined();
  });

  test('returns undefined when the file is not inside a package', () => {
    // No package.json is written, and none exists above the OS temp directory.
    const project = createProject({ 'index.ts': 'export class Foo {}' });

    expect(symbolIdentifier(project.checker, symbolOf(project, 'index.ts', 'Foo'))).toBeUndefined();
  });

  test('strips the jsii outdir prefix from the source path', () => {
    const project = createProject({
      'package.json': JSON.stringify({ jsii: { outdir: 'dist' } }),
      'dist/lib/index.ts': 'export class Foo {}',
    });

    expect(symbolIdentifier(project.checker, symbolOf(project, 'dist/lib/index.ts', 'Foo'))).toBe('lib/index:Foo');
  });

  test('maps compiled output paths back to the source directory using the assembly metadata', () => {
    const project = createProject({
      'package.json': '{}',
      'dist/lib/index.ts': 'export class Foo {}',
    });
    const assembly = withMetadata({ tscRootDir: 'src', tscOutDir: 'dist' });

    expect(symbolIdentifier(project.checker, symbolOf(project, 'dist/lib/index.ts', 'Foo'), { assembly })).toBe(
      'src/lib/index:Foo',
    );
  });

  test('prefers the tsc configuration in package.json over assembly metadata', () => {
    const project = createProject({
      'package.json': JSON.stringify({ jsii: { tsc: { rootDir: 'ts', outDir: 'js' } } }),
      'js/index.ts': 'export class Foo {}',
    });
    const assembly = withMetadata({ tscRootDir: 'src', tscOutDir: 'dist' });

    expect(symbolIdentifier(project.checker, symbolOf(project, 'js/index.ts', 'Foo'), { assembly })).toBe(
      'ts/index:Foo',
    );
  });

  test('strips the .d.ts extension', () => {
    const project = createProject({
      'package.json': '{}',
      'index.d.ts': 'export declare class Foo {}',
    });

    expect(symbolIdentifier(project.checker, symbolOf(project, 'index.d.ts', 'Foo'))).toBe('index:Foo');
  });
});

describe('normalizePath', () => {
  test('returns the path unchanged if rootDir or outDir is not provided', () => {
    expect(normalizePath('dist/lib/index', undefined, 'dist')).toBe('dist/lib/index');
    expect(normalizePath('dist/lib/index', 'src', undefined)).toBe('dist/lib/index');
  });

  test('replaces the outDir with the rootDir', () => {
    expect(normalizePath('dist/lib/index', 'src', 'dist')).toBe('src/lib/index');
  });

  test('handles multi-segment and trailing-slash directories', () => {
    expect(normalizePath('out/js/lib/index', 'ts/', 'out/js/')).toBe('ts/lib/index');
  });

  test('leaves paths that are not under the outDir alone', () => {
    expect(normalizePath('lib/index', 'src', 'dist')).toBe('lib/index');
  });

  test('prefixes the rootDir when the outDir is "."', () => {
    expect(normalizePath('lib/index', 'src', '.')).toBe('src/lib/index');
  });

  test('drops the rootDir prefix when the rootDir is "."', () => {
    expect(normalizePath('dist/lib/index', '.', 'dist')).toBe('lib/index');
  });
});

/** An assembly that was produced by the compiler, whose metadata is replaced. */
function withMetadata(metadata: Record<string, unknown>) {
  return { ...compileJsiiForTest('export class Foo {}').assembly, metadata };
}
