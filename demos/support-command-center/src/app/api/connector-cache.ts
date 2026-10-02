export type ConnectorCache<TConnector> = {
  promise?: Promise<TConnector>;
};

export function loadCachedConnector<TConnector>(
  cache: ConnectorCache<TConnector>,
  load: () => Promise<TConnector>,
): Promise<TConnector> {
  if (cache.promise !== undefined) {
    return cache.promise;
  }

  const promise = load();
  cache.promise = promise;
  promise.catch(() => {
    if (cache.promise === promise) {
      cache.promise = undefined;
    }
  });
  return promise;
}
