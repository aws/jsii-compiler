import { Component, DependencyType, github, javascript, release, Task, TaskStep } from 'projen';
import { DEFAULT_GITHUB_ACTIONS_USER } from 'projen/lib/github/constants';
import { NodePackageManager } from 'projen/lib/javascript';

const CREATE_PATCH_STEP_ID = 'create_patch';
const PATCH_CREATED_OUTPUT = 'patch_created';

/**
 * Options for `UpgradeDependencies`.
 */
export interface UpgradeDependenciesOptions {
  /**
   * List of package names to include during the upgrade.
   *
   * @default - Everything is included.
   */
  readonly include?: string[];

  /**
   * Include a github workflow for creating PR's that upgrades the
   * required dependencies, either by manual dispatch, or by a schedule.
   *
   * If this is `false`, only a local projen task is created, which can be executed manually to
   * upgrade the dependencies.
   *
   * @default - true for root projects, false for sub-projects.
   */
  readonly workflow?: boolean;

  /**
   * Options for the github workflow. Only applies if `workflow` is true.
   *
   * @default - default options.
   */
  readonly workflowOptions?: UpgradeDependenciesWorkflowOptions;

  /**
   * The name of the task that will be created.
   * This will also be the workflow name.
   *
   * @default "upgrade".
   */
  readonly taskName?: string;

  /**
   * Title of the pull request to use (should be all lower-case).
   *
   * @default "upgrade dependencies"
   */
  readonly pullRequestTitle?: string;

  /**
   * Add Signed-off-by line by the committer at the end of the commit log message.
   *
   * @default true
   */
  readonly signoff?: boolean;
}

/**
 * Upgrade node project dependencies.
 */
export class UpgradeDependencies extends Component {
  /**
   * The workflows that execute the upgrades. One workflow per branch.
   */
  public readonly workflows: github.GithubWorkflow[] = [];

  private readonly options: UpgradeDependenciesOptions;
  private readonly _project: javascript.NodeProject;
  private readonly pullRequestTitle: string;

  /**
   * Container definitions for the upgrade workflow.
   */
  public containerOptions?: github.workflows.ContainerOptions;

  /**
   * The upgrade task.
   */
  public readonly upgradeTask: Task;

  /**
   * A task run after the upgrade task.
   */
  public readonly postUpgradeTask: Task;

  private readonly gitIdentity: github.GitIdentity;
  private readonly postBuildSteps: github.workflows.JobStep[];
  private readonly permissions: github.workflows.JobPermissions;

  constructor(project: javascript.NodeProject, options: UpgradeDependenciesOptions = {}) {
    super(project);

    this._project = project;
    this.options = options;
    this.pullRequestTitle = options.pullRequestTitle ?? 'upgrade dependencies';
    this.gitIdentity = options.workflowOptions?.gitIdentity ?? DEFAULT_GITHUB_ACTIONS_USER;
    this.permissions = {
      contents: github.workflows.JobPermission.READ,
      ...options.workflowOptions?.permissions,
    };
    this.postBuildSteps = [];
    this.containerOptions = options.workflowOptions?.container;
    project.addDevDeps('npm-check-updates@^16');

    this.postUpgradeTask =
      project.tasks.tryFind('post-upgrade') ??
      project.tasks.addTask('post-upgrade', {
        description: 'Runs after upgrading dependencies',
      });

    this.upgradeTask = project.addTask(options.taskName ?? 'upgrade', {
      // this task should not run in CI mode because its designed to
      // update package.json and lock files.
      env: { CI: '0' },
      description: this.pullRequestTitle,
      steps: { toJSON: () => this.renderTaskSteps() } as any,
    });
    this.upgradeTask.lock(); // this task is a lazy value, so make it readonly

    if (this.upgradeTask && project.github && (options.workflow ?? true)) {
      if (options.workflowOptions?.branches) {
        for (const branch of options.workflowOptions.branches) {
          this.workflows.push(this.createWorkflow(this.upgradeTask, project.github, branch));
        }
      } else if (release.Release.of(project)) {
        const rel = release.Release.of(project)!;
        rel._forEachBranch((branch: string) => {
          this.workflows.push(this.createWorkflow(this.upgradeTask, project.github!, branch));
        });
      } else {
        // represents the default repository branch.
        // just like not specifying anything.
        const defaultBranch = undefined;
        this.workflows.push(this.createWorkflow(this.upgradeTask, project.github, defaultBranch));
      }
    }
  }

  /**
   * Add steps to execute a successful build.
   * @param steps workflow steps
   */
  public addPostBuildSteps(...steps: github.workflows.JobStep[]) {
    this.postBuildSteps.push(...steps);
  }

  private renderTaskSteps(): TaskStep[] {
    // exclude depedencies that has already version pinned (fully or with patch version) by Projen with ncu (but not package manager upgrade)
    // Getting only unique values through set
    const ncuExcludes = [
      ...new Set(
        this.project.deps.all
          .filter(
            (dep) =>
              dep.name === 'typescript' ||
              (dep.version && dep.version[0] !== '^' && dep.type !== DependencyType.OVERRIDE),
          )
          .map((dep) => dep.name),
      ),
    ];
    // TypeScript is minor-pinned in this project...
    const hasTypescript = ncuExcludes.includes('typescript');

    const ncuIncludes = this.options.include?.filter((item) => !ncuExcludes.includes(item));

    const includeLength = this.options.include?.length ?? 0;
    const ncuIncludesLength = ncuIncludes?.length ?? 0;

    // If all explicit includes already have version pinned, don't add task.
    // Note that without explicit includes task gets added
    if (includeLength > 0 && ncuIncludesLength === 0) {
      return [{ exec: 'echo No dependencies to upgrade.' }];
    }

    const steps = new Array<TaskStep>();

    // update npm-check-updates before everything else, in case there is a bug
    // in it or one of its dependencies. This will make upgrade workflows
    // slightly more stable and resilient to upstream changes.
    steps.push({
      exec: this.renderUpgradePackagesCommand(['npm-check-updates']),
    });

    for (const dep of ['dev', 'optional', 'peer', 'prod', 'bundle']) {
      const ncuCommand = ['npm-check-updates', '--dep', dep, '--upgrade', '--target=minor'];
      // Don't add includes and excludes same time
      if (ncuIncludes) {
        ncuCommand.push(`--filter='${ncuIncludes.join(',')}'`);
      } else if (ncuExcludes.length > 0) {
        ncuCommand.push(`--reject='${ncuExcludes.join(',')}'`);
      }

      steps.push({ exec: ncuCommand.join(' ') });
    }
    if (hasTypescript) {
      const ncuCommand = ['npm-check-updates', '--upgrade', '--target=patch', '--filter=typescript'];
      steps.push({ exec: ncuCommand.join(' ') });
    }

    // run "yarn/npm install" to update the lockfile and install any deps (such as projen)
    steps.push({ exec: this._project.package.installAndUpdateLockfileCommand });

    // run upgrade command to upgrade transitive deps as well
    steps.push({
      exec: this.renderUpgradePackagesCommand(this.options.include),
    });

    // run "projen" to give projen a chance to update dependencies (it will also run "yarn install")
    steps.push({ exec: this._project.projenCommand });

    steps.push({ spawn: this.postUpgradeTask.name });

    return steps;
  }

  private createWorkflow(task: Task, gh: github.GitHub, branch?: string): github.GithubWorkflow {
    const schedule = this.options.workflowOptions?.schedule ?? UpgradeDependenciesSchedule.DAILY;

    const workflowName = `${task.name}${branch ? `-${branch.replace(/\//g, '-')}` : ''}`;
    const workflow = gh.addWorkflow(workflowName);
    const triggers: github.workflows.Triggers = {
      workflowDispatch: {},
      schedule: schedule.cron.length > 0 ? schedule.cron.map((e) => ({ cron: e })) : undefined,
    };
    workflow.on(triggers);

    const upgrade = this.createUpgrade(task, gh, branch);
    const pr = this.createPr(workflow, upgrade);

    const jobs: Record<string, github.workflows.Job> = {};
    jobs[upgrade.jobId] = upgrade.job;
    jobs[pr.jobId] = pr.job;

    workflow.addJobs(jobs);
    return workflow;
  }

  private createUpgrade(task: Task, gh: github.GitHub, branch?: string): Upgrade {
    const runsOn = this.options.workflowOptions?.runsOn ?? ['ubuntu-latest'];

    const with_ = {
      ...(branch ? { ref: branch } : {}),
      ...(gh.downloadLfs ? { lfs: true } : {}),
    };

    const steps: github.workflows.JobStep[] = [
      {
        name: 'Checkout',
        uses: 'actions/checkout@v3',
        with: Object.keys(with_).length > 0 ? with_ : undefined,
      },
      ...this._project.renderWorkflowSetup({ mutable: false }),
      ...(branch && branch !== 'main'
        ? [
            {
              env: {
                // Important: this ensures `yarn projen` runs `yarn install` and not `yarn install:ci` so it can update
                // the yarn.lock file.
                CI: 'false',
              },
              name: 'Back-port projenrc changes from main',
              run: 'git fetch origin main && git checkout FETCH_HEAD -- README.md && yarn projen',
            },
          ]
        : []),
      {
        name: 'Upgrade dependencies',
        run: this._project.runTaskCommand(task),
      },
    ];

    steps.push(...this.postBuildSteps);
    steps.push(
      ...github.WorkflowActions.uploadGitPatch({
        stepId: CREATE_PATCH_STEP_ID,
        outputName: PATCH_CREATED_OUTPUT,
      }),
    );

    return {
      job: {
        name: 'Upgrade',
        container: this.containerOptions,
        permissions: this.permissions,
        runsOn: runsOn ?? ['ubuntu-latest'],
        steps: steps,
        outputs: {
          [PATCH_CREATED_OUTPUT]: {
            stepId: CREATE_PATCH_STEP_ID,
            outputName: PATCH_CREATED_OUTPUT,
          },
        },
      },
      jobId: 'upgrade',
      ref: branch,
    };
  }

  private createPr(workflow: github.GithubWorkflow, upgrade: Upgrade): PR {
    const credentials = this.options.workflowOptions?.projenCredentials ?? workflow.projenCredentials;

    return {
      job: github.WorkflowJobs.pullRequestFromPatch({
        patch: {
          jobId: upgrade.jobId,
          outputName: PATCH_CREATED_OUTPUT,
          ref: upgrade.ref,
        },
        workflowName: workflow.name,
        credentials,
        runsOn: this.options.workflowOptions?.runsOn,
        pullRequestTitle: `chore(deps): ${this.pullRequestTitle}`,
        pullRequestDescription: 'Upgrades project dependencies.',
        gitIdentity: this.gitIdentity,
        assignees: this.options.workflowOptions?.assignees,
        labels: this.options.workflowOptions?.labels,
        signoff: this.options.signoff,
      }),
      jobId: 'pr',
    };
  }

  /**
   * Render a package manager specific command to upgrade all requested dependencies.
   */
  private renderUpgradePackagesCommand(include?: string[]): string {
    function upgradePackages(command: string) {
      return () => {
        return `${command} ${(include ?? []).join(' ')}`.trim();
      };
    }

    const packageManager = this._project.package.packageManager;

    let lazy;
    switch (packageManager) {
      case NodePackageManager.YARN:
      case NodePackageManager.YARN2:
      case NodePackageManager.YARN_CLASSIC:
      case NodePackageManager.YARN_BERRY:
        lazy = upgradePackages('yarn upgrade');
        break;
      case NodePackageManager.NPM:
        lazy = upgradePackages('npm update');
        break;
      case NodePackageManager.PNPM:
        lazy = upgradePackages('pnpm update');
        break;
      default:
        throw new Error(`unexpected package manager ${packageManager}`);
    }

    // return a lazy function so that dependencies include ones that were
    // added post project instantiation (i.e using project.addDeps)
    return lazy as unknown as string;
  }
}

interface Upgrade {
  readonly ref?: string;
  readonly job: github.workflows.Job;
  readonly jobId: string;
}

interface PR {
  readonly job: github.workflows.Job;
  readonly jobId: string;
}

/**
 * Options for `UpgradeDependencies.workflowOptions`.
 */
export interface UpgradeDependenciesWorkflowOptions {
  /**
   * Schedule to run on.
   *
   * @default UpgradeDependenciesSchedule.DAILY
   */
  readonly schedule?: UpgradeDependenciesSchedule;

  /**
   * Choose a method for authenticating with GitHub for creating the PR.
   *
   * When using the default github token, PR's created by this workflow
   * will not trigger any subsequent workflows (i.e the build workflow), so
   * projen requires API access to be provided through e.g. a personal
   * access token or other method.
   *
   * @see https://github.com/peter-evans/create-pull-request/issues/48
   * @default - personal access token named PROJEN_GITHUB_TOKEN
   */
  readonly projenCredentials?: github.GithubCredentials;

  /**
   * Labels to apply on the PR.
   *
   * @default - no labels.
   */
  readonly labels?: string[];

  /**
   * Assignees to add on the PR.
   *
   * @default - no assignees
   */
  readonly assignees?: string[];

  /**
   * Job container options.
   *
   * @default - defaults
   */
  readonly container?: github.workflows.ContainerOptions;

  /**
   * List of branches to create PR's for.
   *
   * @default - All release branches configured for the project.
   */
  readonly branches?: string[];

  /**
   * The git identity to use for commits.
   * @default "github-actions@github.com"
   */
  readonly gitIdentity?: github.GitIdentity;

  /**
   * Github Runner selection labels
   * @default ["ubuntu-latest"]
   */
  readonly runsOn?: string[];

  /**
   * Permissions granted to the upgrade job
   * To limit job permissions for `contents`, the desired permissions have to be explicitly set, e.g.: `{ contents: JobPermission.NONE }`
   * @default `{ contents: JobPermission.READ }`
   */
  readonly permissions?: github.workflows.JobPermissions;
}

/**
 * How often to check for new versions and raise pull requests for version upgrades.
 */
export class UpgradeDependenciesSchedule {
  /**
   * Disables automatic upgrades.
   */
  public static readonly NEVER = new UpgradeDependenciesSchedule([]);

  /**
   * At 00:00.
   */
  public static readonly DAILY = new UpgradeDependenciesSchedule(['0 0 * * *']);

  /**
   * At 00:00 on every day-of-week from Monday through Friday.
   */
  public static readonly WEEKDAY = new UpgradeDependenciesSchedule(['0 0 * * 1-5']);

  /**
   * At 00:00 on Monday.
   */
  public static readonly WEEKLY = new UpgradeDependenciesSchedule(['0 0 * * 1']);

  /**
   * At 00:00 on day-of-month 1.
   */
  public static readonly MONTHLY = new UpgradeDependenciesSchedule(['0 0 1 * *']);

  /**
   * Create a schedule from a raw cron expression.
   */
  public static expressions(cron: string[]) {
    return new UpgradeDependenciesSchedule(cron);
  }

  private constructor(public readonly cron: string[]) {}
}
