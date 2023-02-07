import { typescript } from 'projen';

export class JsiiCalcFixtures {
  public constructor(project: typescript.TypeScriptProject) {
    project.postCompileTask.exec('ts-node projenrc/prepare-fixtures.ts', { name: 'prepare-fixtures' });
  }
}
