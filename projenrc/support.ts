import { JsonFile, Project } from 'projen';
import type { ReleasesDocument } from '../src/support';

export class SupportPolicy {
  public constructor(project: Project) {
    new JsonFile(project, 'releases.json', {
      allowComments: false,
      editGitignore: false,
      obj: {
        current: '4.9',
        maintenance: {},
      } satisfies ReleasesDocument,
      readonly: true,
    });
  }
}
