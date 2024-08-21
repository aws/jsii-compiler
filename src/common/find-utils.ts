import * as fs from 'node:fs';
import * as path from 'node:path';
import { JsiiError } from '../utils';

/**
 * Find a directory up the tree from a starting directory matching a condition
 *
 * Will return `undefined` if no directory matches
 *
 * (This code is duplicated among jsii/jsii-pacmak/jsii-reflect. Changes should be done in all
 * 3 locations, and we should unify these at some point: https://github.com/aws/jsii/issues/3236)
 */
export function findUp(directory: string, pred: (dir: string) => boolean): string | undefined {
  const result = pred(directory);

  if (result) {
    return directory;
  }

  const parent = path.dirname(directory);
  if (parent === directory) {
    return undefined;
  }

  return findUp(parent, pred);
}

/**
 * Find the package.json for a given package upwards from the given directory
 *
 * (This code is duplicated among jsii/jsii-pacmak/jsii-reflect. Changes should be done in all
 * 3 locations, and we should unify these at some point: https://github.com/aws/jsii/issues/3236)
 */
export function findPackageJsonUp(packageName: string, directory: string) {
  return findUp(directory, (dir) => {
    const pjFile = path.join(dir, 'package.json');
    return fs.existsSync(pjFile) && JSON.parse(fs.readFileSync(pjFile, 'utf-8')).name === packageName;
  });
}

/**
 * Find the directory that contains a given dependency, identified by its 'package.json', from a starting search directory
 *
 * (This code is duplicated among jsii/jsii-pacmak/jsii-reflect. Changes should be done in all
 * 3 locations, and we should unify these at some point: https://github.com/aws/jsii/issues/3236)
 */
export function findDependencyDirectory(dependencyName: string, searchStart: string) {
  // Explicitly do not use 'require("dep/package.json")' because that will fail if the
  // package does not export that particular file.
  const entryPoint = require.resolve(dependencyName, {
    paths: [searchStart],
  });

  // Search up from the given directory, looking for a package.json that matches
  // the dependency name (so we don't accidentally find stray 'package.jsons').
  const depPkgJsonPath = findPackageJsonUp(dependencyName, path.dirname(entryPoint));

  if (!depPkgJsonPath) {
    throw new JsiiError(`Could not find dependency '${dependencyName}' from '${searchStart}'`);
  }

  return depPkgJsonPath;
}
