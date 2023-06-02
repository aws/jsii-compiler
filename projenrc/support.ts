import { JsonFile, Project } from 'projen';
import type { ReleasesDocument } from '../src/support';

export const SUPPORT_POLICY: ReleasesDocument = {
  current: '5.1',
  maintenance: {
    '5.0': new Date('2024-01-31'),
  },
};

export class SupportPolicy {
  public constructor(project: Project) {
    new JsonFile(project, 'releases.json', {
      allowComments: false,
      editGitignore: false,
      obj: SUPPORT_POLICY,
      readonly: true,
    });
  }
}
