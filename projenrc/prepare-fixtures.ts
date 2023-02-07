import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

const fixtureRoot = join(__dirname, '..', 'fixtures');
const nodeModulesDir = join(fixtureRoot, 'node_modules');

for (const pkg of [
  '@fixtures/jsii-calc-bundled',
  '@scope/jsii-calc-base',
  '@scope/jsii-calc-base-of-base',
  '@scope/jsii-calc-lib',
  'jsii-calc',
]) {
  const pkgLocation = join(fixtureRoot, pkg);
  const linkLocation = join(nodeModulesDir, pkg);

  if (!existsSync(linkLocation)) {
    mkdirSync(dirname(linkLocation), { recursive: true });
    symlinkSync(pkgLocation, linkLocation, 'dir');
  }
}
