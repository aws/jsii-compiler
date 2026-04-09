import { typescript } from 'projen';

/**
 * Returns the standard workflow setup steps (corepack, setup-node, install).
 * Uses projen's renderWorkflowSetup() to stay in sync with the package manager config.
 */
export function workflowSetup(project: typescript.TypeScriptProject): ReturnType<typeof project.renderWorkflowSetup> {
  return project.renderWorkflowSetup();
}
