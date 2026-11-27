import { typescript } from 'projen';

export class JsiiCalcFixtures {
  public constructor(project: typescript.TypeScriptProject) {
    project.postCompileTask.exec('tsx projenrc/prepare-fixtures.ts', { name: 'prepare-fixtures' });
  }
}
