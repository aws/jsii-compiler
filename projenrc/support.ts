import { JsonFile, Project } from 'projen';
import type { ReleasesDocument } from '../src/support';

export const SUPPORT_POLICY: ReleasesDocument = {
  current: '5.5',
  maintenance: {
    // version: End-of-support date
    '5.0': new Date('2024-01-31'),
    '5.1': new Date('2024-02-28'),
    '5.2': new Date('2024-06-30'),
    '5.3': new Date('2024-10-15'),
    '5.4': new Date('2024-02-28'),
  },
};

export class SupportPolicy {
  public get branches(): {
    [version: string]: string;
  } {
    const branches = {
      [SUPPORT_POLICY.current]: 'main',
    };

    for (const version of Object.keys(SUPPORT_POLICY.maintenance)) {
      branches[version] = `maintenance/v${version}`;
    }

    return branches;
  }

  public constructor(project: Project) {
    new JsonFile(project, 'releases.json', {
      allowComments: false,
      editGitignore: false,
      obj: SUPPORT_POLICY,
      readonly: true,
    });
  }

  /**
   * Get all actively maintained branches
   */
  public activeBranches(includeCurrent = true): {
    [version: string]: string;
  } {
    return Object.fromEntries(
      Object.entries(this.branches).filter(([version]) => {
        if (includeCurrent && version === SUPPORT_POLICY.current) {
          return true;
        }

        // check if branch is still maintained
        return Date.now() <= SUPPORT_POLICY.maintenance[version as any]?.getTime();
      }),
    );
  }
}
