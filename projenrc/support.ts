import { JsonFile, Project } from 'projen';
import type { ReleasesDocument } from '../src/support';

export const SUPPORT_POLICY: ReleasesDocument = {
  current: '5.4',
  maintenance: {
    // version: End-of-support date
    '5.0': new Date('2024-01-31'),
    '5.1': new Date('2024-02-28'),
    '5.2': new Date('2024-06-30'),
    '5.3': new Date('2024-10-15'),
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
