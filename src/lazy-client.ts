/**
 * Lazily created, shared PBX client.
 *
 * One connect is in flight at a time and every concurrent caller awaits it, so
 * parallel cold calls open one socket and nobody receives a client before its
 * connect (and, for AMI, its login) has finished. Each attempt carries a
 * generation so a late result of an old attempt cannot disturb newer state.
 */

interface Attempt<T> {
  gen: number;
  client: T;
  ready: boolean;
  promise: Promise<T>;
}

export function lazyClient<T extends { connect(): Promise<void>; close(): void }>(create: () => T, alive: (c: T) => boolean) {
  let current: Attempt<T> | undefined;
  let generation = 0;

  const start = (): Attempt<T> => {
    const attempt = { gen: ++generation, client: create(), ready: false } as Attempt<T>;
    attempt.promise = attempt.client.connect().then(
      () => {
        if (current === attempt) attempt.ready = true;
        return attempt.client;
      },
      (err) => {
        // Only the current attempt may reset the holder.
        if (current === attempt) current = undefined;
        attempt.client.close();
        throw err;
      }
    );
    current = attempt;
    return attempt;
  };

  return async (): Promise<T> => {
    // A second pass covers a socket that dropped right after connecting.
    for (let pass = 0; pass < 2; pass++) {
      let attempt = current;
      if (attempt?.ready && !alive(attempt.client)) {
        current = undefined;
        attempt.client.close();
        attempt = undefined;
      }
      attempt ??= start();

      const client = await attempt.promise;
      if (alive(client)) return client;
      if (current === attempt) current = undefined;
      client.close();
    }
    throw new Error("connection dropped immediately after connecting");
  };
}
