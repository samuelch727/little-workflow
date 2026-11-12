/** Cache successful construction per agent key; a rejection only resets that key. */
export function retryable<T>(factory: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const cached = new Map<string, Promise<T>>();
  return key => {
    let pending = cached.get(key);
    if (pending === undefined) {
      pending = Promise.resolve().then(() => factory(key)).catch(error => { cached.delete(key); throw error; });
      cached.set(key, pending);
    }
    return pending;
  };
}
