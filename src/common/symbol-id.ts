import * as path from 'node:path';

/**
 * Ensures that the sourcePath is pointing to the source code
 * and not compiled code. This can happen if the root directory
 * and/or out directory is set for the project. We check to see
 * if the out directory is present in the sourcePath, and if so,
 * we replace it with the root directory.
 */
export function normalizePath(sourcePath: string, rootDir?: string, outDir?: string): string {
  if (rootDir === undefined || outDir === undefined) {
    return sourcePath;
  }

  outDir = removeEndSlash(path.normalize(outDir));
  const outDirLength = outDir.split(path.sep).length;
  rootDir = removeEndSlash(path.normalize(rootDir));

  let paths = path.normalize(sourcePath).split(path.sep);
  const pathDir = paths.slice(0, outDirLength).join(path.sep);

  if (outDir === pathDir || outDir === '.') {
    // outDir === '.' is a special case where we do not want
    // to remove any paths from the list.
    if (outDir !== '.') {
      paths = paths.slice(outDirLength);
    }
    sourcePath = rootDir === '.' ? paths.join('/') : `${rootDir}/${paths.join('/')}`;
  }
  return unixize(sourcePath);

  function removeEndSlash(filePath: string) {
    return filePath.endsWith(path.sep) ? filePath.slice(0, filePath.length - 1) : filePath;
  }
}

/**
 * Turn backslashes in a path into forward slashes
 */
function unixize(p: string) {
  return p.replace(/\\/g, '/');
}
