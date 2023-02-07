import * as path from 'node:path';
import { Assembly, loadAssemblyFromPath } from '@jsii/spec';
import { Compiler } from '../src/compiler';
import { loadProjectInfo } from '../src/project-info';

test('integration', () => {
  const calcBaseOfBaseRoot = resolveModuleDir('@scope/jsii-calc-base-of-base');
  const calcBaseRoot = resolveModuleDir('@scope/jsii-calc-base');
  const calcLibRoot = resolveModuleDir('@scope/jsii-calc-lib');
  const calcRoot = resolveModuleDir('jsii-calc');

  compile(calcBaseOfBaseRoot, false);
  compile(calcBaseRoot, true);
  compile(calcLibRoot, true, path.join(calcLibRoot, 'deprecated-to-strip.txt'));
  compile(calcRoot, true);

  expect(neutralize(loadAssemblyFromPath(calcBaseOfBaseRoot))).toMatchSnapshot();
  expect(neutralize(loadAssemblyFromPath(calcBaseRoot))).toMatchSnapshot();
  expect(neutralize(loadAssemblyFromPath(calcLibRoot))).toMatchSnapshot();
  expect(neutralize(loadAssemblyFromPath(calcRoot))).toMatchSnapshot();
});

function compile(projectRoot: string, addDeprecationWarnings: boolean, stripDeprecated?: string) {
  const { projectInfo } = loadProjectInfo(projectRoot);

  const compiler = new Compiler({
    projectInfo,
    addDeprecationWarnings,
    stripDeprecated: stripDeprecated != null,
    stripDeprecatedAllowListFile: stripDeprecated,
  });

  compiler.emit();
}

function neutralize(assm: Assembly): Omit<Assembly, 'jsiiVersion' | 'fingerprint'> {
  delete (assm as any).jsiiVersion;
  delete (assm as any).fingerprint;
  return assm;
}

function resolveModuleDir(name: string) {
  return path.resolve(__dirname, '..', 'fixtures', name);
}
