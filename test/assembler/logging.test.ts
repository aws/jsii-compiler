import * as log4js from 'log4js';
import { compileJsiiForTest } from '../../src/helpers';

describe('assembler logging', () => {
  const recording = log4js.recording();

  beforeEach(() => {
    log4js.configure({
      appenders: { recording: { type: 'recording' } },
      categories: { default: { appenders: ['recording'], level: 'trace' } },
    });
  });

  afterEach(() => {
    recording.erase();
    log4js.configure({
      appenders: { console: { type: 'console' } },
      categories: { default: { appenders: ['console'], level: 'off' } },
    });
  });

  // @TODO(ts7): the TypeScript 7 assembler does not log "Registering JSII ..." for each type
  test.skip('traces each declaration it processes, and logs each registered type', () => {
    compileJsiiForTest({
      'index.ts': `
        export * as sub from './sub';

        export namespace ns {
          export class InNamespace {}
        }

        export class Klass {
          public readonly prop: string = 'value';
          public method(param: string): string {
            return param;
          }
        }

        export interface IInterface {
          readonly prop: string;
        }

        export enum Enum {
          ONE = 'one',
          TWO = 'two',
        }
      `,
      'sub.ts': 'export class InSubmodule {}',
    });

    const messages = recording
      .replay()
      .filter((event) => event.categoryName === 'jsii/assembler')
      .map((event) => `${event.level.levelStr} ${stripColors(event.data.join(' '))}`);

    expect(messages).toEqual([
      'TRACE Processing source file: index.ts',
      // The submodule is logged with the name of the module it comes from.
      expect.stringMatching(/^TRACE Entering submodule: ".*sub"$/),
      'TRACE Processing class: sub.InSubmodule',
      'INFO Registering JSII class: testpkg.sub.InSubmodule',
      expect.stringMatching(/^TRACE Leaving submodule: ".*sub"$/),
      'TRACE Entering namespace: ns',
      'TRACE Processing class: ns.InNamespace',
      'INFO Registering JSII class: testpkg.ns.InNamespace',
      'TRACE Leaving namespace:  ns',
      'TRACE Processing class: .Klass',
      'TRACE Processing property: testpkg.Klass#prop',
      'TRACE Processing method: testpkg.Klass#method',
      'TRACE Processing parameter: param',
      'INFO Registering JSII class: testpkg.Klass',
      'TRACE Processing interface: .IInterface',
      'TRACE Processing property: testpkg.IInterface#prop',
      'INFO Registering JSII interface: testpkg.IInterface',
      'TRACE Processing enum: .Enum',
      'INFO Registering JSII enum: testpkg.Enum',
      expect.stringMatching(/^TRACE Emitting assembly: .*\.jsii$/),
    ]);
  });
});

function stripColors(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}
