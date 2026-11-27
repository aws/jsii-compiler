import { DiagnosticCategory } from 'typescript';
import { JsiiDiagnostic } from '../src/jsii-diagnostic';
import { parsePerson, parseRepository, formatCompilationSummary } from '../src/utils';
import { silencedWarnings } from '../src/warnings';

function makeDiag(category: DiagnosticCategory): import('typescript').Diagnostic {
  return { category, code: 1234, file: undefined, start: undefined, length: undefined, messageText: 'test' };
}

describe('formatCompilationSummary', () => {
  afterEach(() => {
    silencedWarnings.clear();
  });

  test('successful with no diagnostics', () => {
    const result = formatCompilationSummary([], false, 1420);
    expect(result).toContain('✨ Successful');
    expect(result).toContain('Errors: 0');
    expect(result).toContain('Warnings: 0');
    expect(result).toContain('Time: 1.42s');
    expect(result).not.toContain('with warnings');
  });

  test('successful with warnings', () => {
    const diags = [makeDiag(DiagnosticCategory.Warning), makeDiag(DiagnosticCategory.Warning)];
    const result = formatCompilationSummary(diags, false, 870);
    expect(result).toContain('✨ Successful with warnings');
    expect(result).toContain('Errors: 0');
    expect(result).toContain('Warnings: 2');
    expect(result).not.toContain('silenced');
  });

  test('failed with errors', () => {
    const diags = [
      makeDiag(DiagnosticCategory.Error),
      makeDiag(DiagnosticCategory.Error),
      makeDiag(DiagnosticCategory.Warning),
    ];
    const result = formatCompilationSummary(diags, true, 500);
    expect(result).toContain('❌ Failed with errors');
    expect(result).toContain('Errors: 2');
    expect(result).toContain('Warnings: 1');
    expect(result).toContain('Time: 0.50s');
  });

  test('shows silenced warning count', () => {
    silencedWarnings.add(5018);
    const diags = [
      JsiiDiagnostic.JSII_5018_RESERVED_WORD.createDetached('test', ['Python']),
      makeDiag(DiagnosticCategory.Warning),
    ];
    const result = formatCompilationSummary(diags, false, 1000);
    expect(result).toContain('Warnings: 1 (+1 silenced)');
  });

  test('all warnings silenced shows successful without "with warnings"', () => {
    silencedWarnings.add(5018);
    const diags = [JsiiDiagnostic.JSII_5018_RESERVED_WORD.createDetached('test', ['Python'])];
    const result = formatCompilationSummary(diags, false, 1000);
    expect(result).toContain('✨ Successful\n');
    expect(result).not.toContain('with warnings');
    expect(result).toContain('Warnings: 0 (+1 silenced)');
  });

  test('ignores suggestion and message diagnostics', () => {
    const diags = [makeDiag(DiagnosticCategory.Suggestion), makeDiag(DiagnosticCategory.Message)];
    const result = formatCompilationSummary(diags, false, 100);
    expect(result).toContain('Errors: 0');
    expect(result).toContain('Warnings: 0');
  });
});

describe('parsePerson', () => {
  test('correctly parses NPM documentation example', () => {
    const parsed = parsePerson('Barney Rubble <b@rubble.com> (http://barnyrubble.tumblr.com/)');
    expect(parsed).toEqual({
      name: 'Barney Rubble',
      email: 'b@rubble.com',
      url: 'http://barnyrubble.tumblr.com/',
    });
  });

  test('correctly parses NPM documentation example (minus URL)', () => {
    const parsed = parsePerson('Barney Rubble <b@rubble.com>');
    expect(parsed).toEqual({
      name: 'Barney Rubble',
      email: 'b@rubble.com',
    });
  });

  test('correctly parses NPM documentation example (minus email)', () => {
    const parsed = parsePerson('Barney Rubble (http://barnyrubble.tumblr.com/)');
    expect(parsed).toEqual({
      name: 'Barney Rubble',
      url: 'http://barnyrubble.tumblr.com/',
    });
  });

  test('correctly parses NPM documentation example (minus email and URL)', () => {
    const parsed = parsePerson('Barney Rubble');
    expect(parsed).toEqual({
      name: 'Barney Rubble',
    });
  });
});

describe('parseRepository', () => {
  test('correctly parses npm/npm', () => {
    const parsed = parseRepository('npm/npm');
    expect(parsed).toEqual({
      url: 'https://github.com/npm/npm.git',
    });
  });

  test('correctly parses github:user/repo', () => {
    const parsed = parseRepository('github:user/repo');
    expect(parsed).toEqual({
      url: 'https://github.com/user/repo.git',
    });
  });

  test('correctly parses gist:user/11081aaa281', () => {
    const parsed = parseRepository('gist:user/11081aaa281');
    expect(parsed).toEqual({
      url: 'https://gist.github.com/user/11081aaa281.git',
    });
  });

  test('correctly parses bitbucket:user/repo', () => {
    const parsed = parseRepository('bitbucket:user/repo');
    expect(parsed).toEqual({
      url: 'https://bitbucket.org/user/repo.git',
    });
  });

  test('correctly parses gitlab:user/repo', () => {
    const parsed = parseRepository('gitlab:user/repo');
    expect(parsed).toEqual({
      url: 'https://gitlab.com/user/repo.git',
    });
  });

  test('passes through other values', () => {
    const parsed = parseRepository('not-even-a-url-:sadface:');
    expect(parsed).toEqual({
      url: 'not-even-a-url-:sadface:',
    });
  });
});
