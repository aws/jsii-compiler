/** @internal */
export interface ReleasesDocument {
  /**
   * The release line that occupies the 'Current' stage.
   */
  readonly current: ReleaseLine;
  /**
   * Release lines currently in 'Maintenance' with the date at which they are
   * planned to go into the 'End-of-Support' stage. This date should always be
   * set a minimum of 6 months in the future when a release line is added to the
   * list.
   */
  readonly maintenance: { readonly [release: ReleaseLine]: Date };
  /**
   * Release lines that are currently out-of-support. This is semantically
   * equivalent to being in the `maintenance` list with a past date, but offers
   * slightly faster look-up.
   */
  readonly endOfSupport?: readonly ReleaseLine[];
}


export type ReleaseLine = `${number}.${number}`;