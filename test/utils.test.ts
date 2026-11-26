import * as log4js from 'log4js';
import * as ts from 'typescript';
import { DiagnosticCategory } from 'typescript';
import { JsiiDiagnostic } from '../src/jsii-diagnostic';
import {
  DIAGNOSTICS,
  diagnosticsLogger,
  formatCompilationSummary,
  formatDiagnostic,
  JsiiError,
  logDiagnostic,
  parentFqn,
  parsePerson,
  parseRepository,
  stripAnsi,
} from '../src/utils';
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

describe('diagnosticsLogger', () => {
  const makeLogger = (enabled: Partial<Record<'error' | 'warn' | 'debug' | 'trace', boolean>>) =>
    ({
      isErrorEnabled: () => !!enabled.error,
      isWarnEnabled: () => !!enabled.warn,
      isDebugEnabled: () => !!enabled.debug,
      isTraceEnabled: () => !!enabled.trace,
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
    } as unknown as log4js.Logger & Record<'error' | 'warn' | 'debug' | 'trace', jest.Mock>);

  test.each([
    [DiagnosticCategory.Error, 'error'],
    [DiagnosticCategory.Warning, 'warn'],
    [DiagnosticCategory.Message, 'debug'],
    [DiagnosticCategory.Suggestion, 'trace'],
  ] as const)('category %s is logged at level "%s"', (category, level) => {
    const logger = makeLogger({ error: true, warn: true, debug: true, trace: true });

    const logFunc = diagnosticsLogger(logger, makeDiag(category));
    logFunc!('message');

    expect(logger[level]).toHaveBeenCalledWith('message');
  });

  test.each([
    DiagnosticCategory.Error,
    DiagnosticCategory.Warning,
    DiagnosticCategory.Message,
    DiagnosticCategory.Suggestion,
  ])('category %s has no logger when its level is disabled', (category) => {
    expect(diagnosticsLogger(makeLogger({}), makeDiag(category))).toBeUndefined();
  });

  test('an unknown category is logged at the "trace" level', () => {
    const logger = makeLogger({ trace: true });

    diagnosticsLogger(logger, makeDiag(1234 as DiagnosticCategory))!('message');

    expect(logger.trace).toHaveBeenCalledWith('message');
  });
});

describe('formatDiagnostic', () => {
  const detached = () => JsiiDiagnostic.JSII_0003_MISSING_README.createDetached();

  test('formats a plain TypeScript diagnostic without any jsii annotation', () => {
    const formatted = stripAnsi(formatDiagnostic(makeDiag(DiagnosticCategory.Error), process.cwd()));

    expect(formatted).toContain('error TS1234: test');
    expect(formatted).not.toContain('JSII');
  });

  test('formats a jsii diagnostic with its code and name', () => {
    const formatted = stripAnsi(formatDiagnostic(detached(), process.cwd()));

    expect(formatted).toContain('JSII3: There is no "README.md" file.');
    expect(formatted).toContain('[metadata/missing-readme]');
  });

  test('formats a jsii diagnostic whose code is not registered without a name', () => {
    const unregistered = detached();
    (unregistered as { jsiiCode: number }).jsiiCode = 99999;

    const formatted = stripAnsi(formatDiagnostic(unregistered, process.cwd()));

    expect(formatted).toContain('JSII99999:');
    expect(formatted).not.toContain('[');
  });

  test('appends the name to a jsii diagnostic that is formatted on a single line', () => {
    const original = ts.sys.newLine;
    (ts.sys as { newLine: string }).newLine = '';
    try {
      const formatted = stripAnsi(formatDiagnostic(detached(), process.cwd()));

      expect(formatted).toMatch(/^warning JSII3: There is no "README.md" file.+ \[metadata\/missing-readme\]\n$/);
    } finally {
      (ts.sys as { newLine: string }).newLine = original;
    }
  });
});

describe('logDiagnostic', () => {
  const logger = log4js.getLogger(DIAGNOSTICS);
  const originalLevel = logger.level;

  afterEach(() => {
    logger.level = originalLevel;
    silencedWarnings.clear();
    jest.restoreAllMocks();
  });

  test('logs using the logger for the diagnostic category', () => {
    logger.level = 'error';
    const error = jest.spyOn(Object.getPrototypeOf(logger), 'error').mockImplementation(() => undefined);

    logDiagnostic(makeDiag(DiagnosticCategory.Error), process.cwd());

    expect(error).toHaveBeenCalledTimes(1);
    expect(stripAnsi(error.mock.calls[0][0])).toBe('error TS1234: test');
  });

  test('does not log when the logger level is disabled', () => {
    logger.level = 'off';
    const error = jest.spyOn(Object.getPrototypeOf(logger), 'error').mockImplementation(() => undefined);

    logDiagnostic(makeDiag(DiagnosticCategory.Error), process.cwd());

    expect(error).not.toHaveBeenCalled();
  });

  test('does not log silenced diagnostics', () => {
    logger.level = 'all';
    silencedWarnings.add(3);
    const warn = jest.spyOn(Object.getPrototypeOf(logger), 'warn').mockImplementation(() => undefined);

    logDiagnostic(JsiiDiagnostic.JSII_0003_MISSING_README.createDetached(), process.cwd());

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('stripAnsi', () => {
  test('removes color codes', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m and \u001b[1;32mgreen\u001b[0m')).toBe('red and green');
  });

  test('leaves plain text untouched', () => {
    expect(stripAnsi('plain')).toBe('plain');
  });
});

describe('parentFqn', () => {
  test('returns the parent namespace', () => {
    expect(parentFqn('aws-cdk-lib.aws_s3.Bucket')).toBe('aws-cdk-lib.aws_s3');
  });

  test('returns an empty string for a top-level name', () => {
    expect(parentFqn('Bucket')).toBe('');
  });
});

describe('JsiiError', () => {
  test('carries its message and does not show help by default', () => {
    const error = new JsiiError('oops');

    expect(error).toBeInstanceOf(JsiiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('oops');
    expect(error.showHelp).toBe(false);
  });

  test('can request that help is shown', () => {
    expect(new JsiiError('oops', true).showHelp).toBe(true);
  });
});

describe('parsePerson (invalid input)', () => {
  test('rejects an empty string', () => {
    expect(() => parsePerson('')).toThrow('Invalid stringified "person" value: ');
  });
});
