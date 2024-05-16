import * as Case from 'case';

const withCache =
  (func: (text: string) => string): ((text: string) => string) =>
  (text: string) =>
    Cache.fetch(text, func);

export const camel = withCache(Case.camel);
export const constant = withCache(Case.constant);
export const pascal = withCache(Case.pascal);
export const snake = withCache(Case.snake);
export const kebab = withCache(Case.kebab);

class Cache {
  public static fetch(text: string, func: (text: string) => string): string {
    // Check whether we have a cache for this function...
    const cacheKey = CacheKey.for(func);
    let cache = this.CACHES.get(cacheKey);
    if (cache == null) {
      // If not, create one...
      cache = new Map<string, string>();
      this.CACHES.set(cacheKey, cache);
    }

    // Check if the current cache has a value for this text...
    const cached = cache.get(text);
    if (cached != null) {
      return cached;
    }

    // If not, compute one...
    const result = func(text);
    cache.set(text, result);
    return result;
  }

  // Cache is indexed on a weak CacheKey so the cache can be purged under memory pressure
  private static readonly CACHES = new WeakMap<CacheKey, Map<string, string>>();

  private constructor() {}
}

class CacheKey {
  public static for(data: any) {
    const entry = this.STORE.get(data)?.deref();
    if (entry != null) {
      return entry;
    }
    const newKey = new CacheKey();
    this.STORE.set(data, new WeakRef(newKey));
    return newKey;
  }

  // Storing cache keys as weak references to allow garbage collection if there is memory pressure.
  private static readonly STORE = new Map<any, WeakRef<CacheKey>>();

  private constructor() {}
}
