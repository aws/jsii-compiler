/** Hand-written declaration for the downlevel-dts module */
declare module 'downlevel-dts' {
  /**
   * Rewrite .d.ts files created by any version of TypeScript so that they work
   * with TypeScript 3.4 or later. It does this by converting code with new
   * features into code that uses equivalent old features.
   *
   * @param src           the directory containing the original .d.ts files
   * @param target        the directory in which to place re-written files
   * @param targetVersion the target TypeScript version compatibility
   *
   * @note The "real" signature would allow semver.SemVer instances to be
   *       provided as `targetVersion`, but some code-path involves an
   *       `instanceof` test which will fail if somehow `downlevel-dts` is
   *       provided with its own install of the `semver` dependency, which we
   *       cannot control, so we disallow using `semver.SemVer` instances here.
   */
  export function main(src: string, target: string, targetVersion: string): void;
}
