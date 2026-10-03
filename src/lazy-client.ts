/**
 * Lazily created, shared PBX client.
 *
 * One connect is in flight at a time and every concurrent caller awaits it, so
 * parallel cold calls open one socket and nobody receives a client before its
 * connect (and, for AMI, its login) has finished. A late result of an old
 * attempt cannot disturb newer state: only the current attempt may change it.
 */

interface Attempt<T> {
  client: T;
  ready: boolean;
  promise: Promise<T>;
  cancel: () => void;
}

export function lazyClient<T extends { connect(): Promise<void>; close(): void }>(create: () => T, alive: (c: T) => boolean, signal?: AbortSignal) {
  let current: Attempt<T> | undefined;
  let closed = signal?.aborted ?? false;
  const check = () => { if (closed) throw new Error("client holder closed"); };
  signal?.addEventListener("abort", () => {
    closed = true;
    const attempt = current;
    current = undefined;
    attempt?.client.close();
    attempt?.cancel();
  }, { once: true });

  const start = (): Attempt<T> => {
    check();
    const attempt = { client: create(), ready: false } as Attempt<T>;
    const cancelled = new Promise<never>((_resolve, reject) => {
      attempt.cancel = () => reject(new Error("client holder closed"));
    });
    attempt.promise = Promise.race([attempt.client.connect(), cancelled]).then(
      () => {
        check();
        if (current === attempt) attempt.ready = true;
        return attempt.client;
      },
      (err) => {
        // Only the current attempt may reset the holder.
        if (current === attempt) { current = undefined; attempt.client.close(); }
        throw err;
      }
    );
    current = attempt;
    return attempt;
  };

  return async (): Promise<T> => {
    // A second pass covers a socket that dropped right after connecting.
    for (let pass = 0; pass < 2; pass++) {
      check();
      let attempt = current;
      if (attempt?.ready && !alive(attempt.client)) {
        current = undefined;
        attempt.client.close();
        attempt = undefined;
      }
      attempt ??= start();

      const client = await attempt.promise;
      check();
      if (alive(client)) return client;
      if (current === attempt) current = undefined;
      client.close();
    }
    throw new Error("connection dropped immediately after connecting");
  };
}
