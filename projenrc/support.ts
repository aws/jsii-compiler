import { JsonFile, Project } from 'projen';
import type { ReleasesDocument } from '../src/support';

export class SupportPolicy {
  public constructor(project: Project) {
    new JsonFile(project, 'releases.json', {
      allowComments: false,
      editGitignore: false,
      obj: {
        current: '5.0',
        maintenance: {},
      } satisfies ReleasesDocument,
      readonly: true,
    });
  }
}
