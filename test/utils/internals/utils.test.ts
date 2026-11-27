import * as log4js from 'log4js';
import { Diagnostic, DiagnosticCategory } from 'typescript';

import { JsiiDiagnostic } from '../../../src/jsii-diagnostic';
import {
  DIAGNOSTICS,
  diagnosticsLogger,
  formatDiagnostic,
  JsiiError,
  logDiagnostic,
  parentFqn,
  parsePerson,
  stripAnsi,
} from '../../../src/utils';
import { silencedWarnings } from '../../../src/warnings';

function makeDiag(category: DiagnosticCategory): Diagnostic {
  return { category, code: 1234, file: undefined, start: undefined, length: undefined, messageText: 'test' };
}

/**
 * Configures log4js to record what is logged, at the given level. The loggers are real: what they log is what is
 * recorded.
 */
function recordLogs(level: string) {
  const recording = log4js.recording();
  log4js.configure({
    appenders: { recording: { type: 'recording' } },
    categories: { default: { appenders: ['recording'], level } },
  });
  recording.erase();
  return recording;
}

afterEach(() => {
  log4js.configure({
    appenders: { console: { type: 'console' } },
    categories: { default: { appenders: ['console'], level: 'off' } },
  });
  silencedWarnings.clear();
});

describe('diagnosticsLogger', () => {
  test.each([
    [DiagnosticCategory.Error, 'ERROR'],
    [DiagnosticCategory.Warning, 'WARN'],
    [DiagnosticCategory.Message, 'DEBUG'],
    [DiagnosticCategory.Suggestion, 'TRACE'],
  ])('category %s is logged at level "%s"', (category, level) => {
    const recording = recordLogs('trace');

    diagnosticsLogger(log4js.getLogger('test'), makeDiag(category))!('message');

    expect(recording.replay().map((event) => [event.level.levelStr, event.data])).toEqual([[level, ['message']]]);
  });

  test.each([
    DiagnosticCategory.Error,
    DiagnosticCategory.Warning,
    DiagnosticCategory.Message,
    DiagnosticCategory.Suggestion,
  ])('category %s has no logger when its level is disabled', (category) => {
    recordLogs('off');

    expect(diagnosticsLogger(log4js.getLogger('test'), makeDiag(category))).toBeUndefined();
  });

  test('an unknown category is logged at the "trace" level', () => {
    const recording = recordLogs('trace');

    diagnosticsLogger(log4js.getLogger('test'), makeDiag(1234 as DiagnosticCategory))!('message');

    expect(recording.replay().map((event) => event.level.levelStr)).toEqual(['TRACE']);
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
});

describe('logDiagnostic', () => {
  test('logs using the logger for the diagnostic category', () => {
    const recording = recordLogs('error');

    logDiagnostic(makeDiag(DiagnosticCategory.Error), process.cwd());

    const events = recording.replay().filter((event) => event.categoryName === DIAGNOSTICS);
    expect(events.map((event) => [event.level.levelStr, stripAnsi(event.data.join(' '))])).toEqual([
      ['ERROR', 'error TS1234: test'],
    ]);
  });

  test('does not log when the logger level is disabled', () => {
    const recording = recordLogs('off');

    logDiagnostic(makeDiag(DiagnosticCategory.Error), process.cwd());

    expect(recording.replay()).toEqual([]);
  });

  test('does not log silenced diagnostics', () => {
    const recording = recordLogs('all');
    silencedWarnings.add(3);

    logDiagnostic(JsiiDiagnostic.JSII_0003_MISSING_README.createDetached(), process.cwd());

    expect(recording.replay()).toEqual([]);
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
