export abstract class Sets {
  /**
   * Return the intersection of N sets
   */
  public static intersection<T>(...xss: Array<Set<T>>): Set<T> {
    if (xss.length === 0) {
      return new Set();
    }
    const ret = new Set(xss[0]);
    for (const x of xss[0]) {
      if (!xss.every((xs) => xs.has(x))) {
        ret.delete(x);
      }
    }
    return ret;
  }

  /**
   * Return the union of N sets
   */
  public static union<T>(...xss: Array<Set<T>>): Set<T> {
    return new Set(xss.flatMap((xs) => Array.from(xs)));
  }

  /**
   * Return the diff of 2 sets
   */
  public static diff<T>(xs: Set<T>, ys: Set<T>) {
    return new Set(Array.from(xs).filter((x) => !ys.has(x)));
  }

  public static *intersect<T>(xs: Set<T>, ys: Set<T>) {
    for (const x of xs) {
      if (ys.has(x)) {
        yield x;
      }
    }
  }
}
