# New TypeScript Release Process

This document outlines the complete process for adding support for a new TypeScript version in the jsii-compiler project. This process should be followed whenever a new major or minor TypeScript version is released.

## Overview

The jsii-compiler project maintains support for multiple TypeScript versions simultaneously, with a current version and several maintenance versions. When a new TypeScript version is released, the current version becomes a maintenance version, and the new version becomes current.

## Prerequisites

- Access to the AWS jsii-compiler repository with push permissions
- GitHub CLI (`gh`) installed and authenticated
- Node.js and Yarn installed locally
- Understanding of conventional commits and branch naming conventions

## Step-by-Step Process

The complete process is documented in this steering document. This document is the source of truth.
Follow the following steps in order.

For any manual steps, give the user clear instructions on how to complete these steps.
sk the user to complete the steps before continuing.
**Only continue once the user as confirmed instructions were successfully executed.**

### 1. Fork Current Main to Maintenance Branch

```bash
git switch main && git fetch --all && git pull
git push origin main:maintenance/vX.Y
```

Where `X.Y` is the TypeScript version that is about to be replaced by the new release.

### 2. Update Support Policy

Edit `projenrc/support.ts`:

- Change `current` to the new TypeScript version (e.g., `'5.9'`)
- Add the previous current version to the `maintenance` object
- Set the EOS (End of Support) date to **6 months from today**, rounded up to the mid-point (15th) or end of month

**Date Calculation Example:**

- If today is August 5, 2025
- 6 months later = February 5, 2026
- Round up to midpoint = February 15, 2026

### 3. Update Minimum Node.js Version

In `.projenrc.ts`, update `minNodeVersion` following the AWS CDK Node.js support policy. The AWS CDK extends support for Node.js versions 6 months beyond their official End-of-Life (EOL) dates.

Refer to the [AWS CDK Node.js version timeline](https://docs.aws.amazon.com/cdk/v2/guide/node-versions.html#node-version-timeline) for the current support status and drop support only for versions that have exceeded the extended 6-month support period.

### 4. Update README Version Table

In `README.md`, update the version table:

- Add new version as "Current" with "TBD" EOS date
- Move previous current version to "Maintenance" with calculated EOS date
- **Remove any versions that have reached EOS** (past their EOS date)

### 5. Update GitHub Branch Protection Rules (Manual)

**Add to "current" ruleset:**

- `maintenance/vX.Y` (the new maintenance branch)

**Remove from "current" ruleset and add to "end-of-support" ruleset:**

- Any branches for versions that have reached EOS

### 6. Update Build Workflow Node.js Matrix

The build workflow automatically respects the `minNodeVersion` setting, but you may need to update the `BuildWorkflow` class in `projenrc/build-workflow.ts` to ensure it properly filters Node.js versions based on the minimum requirement.

### 7. Run Projen

```bash
npx projen
```

This regenerates all project files based on the updated configuration.

### 8. Build and Test

```bash
npx projen build
```

Resolve any TypeScript compilation errors that might be introduced by the new TypeScript version. Common issues include:

- **Stricter type checking**: New TypeScript versions often have stricter type checking
- **Deprecated APIs**: Some TypeScript APIs may be deprecated or removed
- **New compiler options**: May need to update tsconfig settings

### 9. Create Pull Request

Create a branch following the naming convention:

```bash
git checkout -b feat/typescript-X.Y
```

Commit changes with conventional commit message:

```bash
git commit -m "feat: TypeScript X.Y

Adds support for TypeScript X.Y. See https://devblogs.microsoft.com/typescript/announcing-typescript-X-Y/ for details on the new features and changes."
```

Create PR using GitHub CLI:

```bash
git push -u origin feat/typescript-X.Y
gh pr create --title "feat: TypeScript X.Y" --body "Adds support for TypeScript X.Y. See [TypeScript X.Y blog post](https://devblogs.microsoft.com/typescript/announcing-typescript-X-Y/) for details on the new features and changes.

---

By submitting this pull request, I confirm that my contribution is made under the terms of the [Apache 2.0 license].

[Apache 2.0 license]: https://www.apache.org/licenses/LICENSE-2.0"
```

### 10. Manual Release (Post-Merge) (Manual)

**Important:** Merging the PR does not trigger an automatic release. Releases are performed on a weekly schedule, but you can manually trigger a release:

1. Go to <https://github.com/aws/jsii-compiler/actions/workflows/auto-tag-releases.yml>
2. Click "Run workflow"
3. Select the main branch
4. Click "Run workflow"

### 11. Update jsii-rosetta (Manual)

Perform similar version update steps for the `jsii-rosetta` repository following their specific process.

## File Locations and Key Changes

### Files to Modify

- `projenrc/support.ts` - Support policy and version configuration
- `.projenrc.ts` - Minimum Node.js version
- `README.md` - Version table
- `projenrc/build-workflow.ts` - Node.js version filtering (if needed)

### Files Auto-Generated by Projen

- `.github/workflows/build.yml` - Test matrix with Node.js versions
- `.github/workflows/auto-tag-releases-vX.Y.yml` - Release workflow for maintenance branch
- `.github/workflows/auto-tag-dev-vX.Y.yml` - Dev release workflow for maintenance branch
- `.github/workflows/upgrade-maintenance-vX.Y.yml` - Dependency upgrade workflow
- `releases.json` - Support policy JSON file

## Common Issues and Solutions

### TypeScript Compilation Errors

**Double Nullish Coalescing:**

```typescript
// Error: This expression is never nullish
const libs = options.lib ?? [ts.getDefaultLibFileName(options)] ?? [];

// Fix: Remove redundant nullish coalescing
const libs = options.lib ?? [ts.getDefaultLibFileName(options)];
```

**Stricter Type Checking:**

- Check for new TypeScript strict mode options
- Update type annotations as needed
- Review nullable/undefined handling

### Node.js Version Matrix Not Updating

If the build workflow still includes old Node.js versions after updating `minNodeVersion`:

1. Check `projenrc/build-workflow.ts` has proper filtering logic
2. Ensure `minNodeMajor` calculation is correct
3. Run `npx projen` to regenerate workflows

**Note:** Follow the AWS CDK Node.js support policy which extends support 6 months beyond official Node.js EOL dates. Do not drop support for Node.js versions that are still within the extended support period.

### EOS Date Calculation

Always calculate EOS dates as **6 months from the current date**, not from the release date:

- Use the actual date when performing the update
- Round up to 15th (midpoint) or end of month
- Example: August 5, 2025 + 6 months = February 15, 2026

## Validation Checklist

Before submitting the PR, verify:

- [ ] New TypeScript version is set as current in `projenrc/support.ts`
- [ ] Previous version moved to maintenance with correct EOS date
- [ ] `minNodeVersion` updated to latest LTS Node.js version
- [ ] README version table updated and EOS versions removed
- [ ] `npx projen` runs without errors
- [ ] `npx projen build` passes all tests
- [ ] Build workflow matrix excludes old Node.js versions
- [ ] PR follows conventional commit format
- [ ] PR includes link to TypeScript release blog post

## Post-Release Tasks

After the PR is merged and release is triggered:

1. Monitor the release workflow for any issues
2. Update jsii-rosetta with similar changes
3. Communicate the new version availability to stakeholders
4. Update any dependent projects or documentation

## References

- [TypeScript Release Blog Posts](https://devblogs.microsoft.com/typescript/)
- [Node.js Release Schedule](https://nodejs.org/en/about/releases/)
- [AWS CDK Node.js Version Timeline](https://docs.aws.amazon.com/cdk/v2/guide/node-versions.html#node-version-timeline)
- [jsii-compiler Repository](https://github.com/aws/jsii-compiler)
- [Conventional Commits](https://www.conventionalcommits.org/)
