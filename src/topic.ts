export interface Topic {
  readonly name: string;
  readonly key: string;
}

export function topic<const Name extends string, Args extends unknown[]>(
  name: Name,
  key: (...args: Args) => string
): (...args: Args) => { readonly name: Name; readonly key: string } {
  return (...args) => ({ name, key: key(...args) });
}

export interface PubSub<Event extends Topic> {
  /** Call after committing the state change. Listeners enqueue work and return. */
  publish(event: Event): Promise<void>;
  /** Resolve once subsequent publications can reach the listener. */
  subscribe(
    event: Event,
    listener: () => void,
    /** Signal that this subscription can no longer deliver notifications. */
    onDisconnect?: () => void
  ): Promise<() => void>;
}

export function topicKey(event: Topic): string {
  return JSON.stringify([event.name, event.key]);
}

export function createMemoryPubSub<Event extends Topic>(): PubSub<Event> {
  const topics = new Map<string, Set<() => void>>();

  return {
    async publish(event) {
      for (const notify of topics.get(topicKey(event)) ?? []) notify();
    },
    async subscribe(event, listener) {
      const key = topicKey(event);
      const listeners = topics.get(key) ?? new Set();
      // Each subscription owns its cleanup, even for the same callback.
      const notify = () => listener();
      listeners.add(notify);
      topics.set(key, listeners);
      return () => {
        if (topics.get(key) !== listeners) return;
        listeners.delete(notify);
        if (listeners.size === 0) topics.delete(key);
      };
    },
  };
}

/** Share one upstream subscription per Topic within an adapter instance. */
export function shareTopicSubscriptions<Event extends Topic>(
  upstream: PubSub<Event>
): PubSub<Event> {
  type Listener = { notify: () => void; disconnect: (() => void) | undefined };
  interface Subscription {
    listeners: Set<Listener>;
    ready: Promise<void>;
    stop?: () => void;
  }
  const subscriptions = new Map<string, Subscription>();

  function start(key: string, topic: Event) {
    const entry: Subscription = {
      listeners: new Set(),
      ready: Promise.resolve(),
    };
    subscriptions.set(key, entry);
    entry.ready = Promise.resolve()
      .then(() =>
        upstream.subscribe(
          topic,
          () => {
            if (subscriptions.get(key) !== entry) return;
            for (const listener of entry.listeners) listener.notify();
          },
          () => {
            if (subscriptions.get(key) !== entry) return;
            subscriptions.delete(key);
            const listeners = [...entry.listeners];
            entry.listeners.clear();
            entry.stop?.();
            for (const listener of listeners) listener.disconnect?.();
          }
        )
      )
      .then(
        (stop) => {
          if (subscriptions.get(key) === entry) entry.stop = stop;
          else stop();
        },
        (error: unknown) => {
          if (subscriptions.get(key) === entry) subscriptions.delete(key);
          entry.listeners.clear();
          throw error;
        }
      );
    return entry;
  }

  return {
    publish: (event) => upstream.publish(event),
    async subscribe(topic, notify, disconnect) {
      const key = topicKey(topic);
      const entry = subscriptions.get(key) ?? start(key, topic);
      const listener = { notify, disconnect };
      entry.listeners.add(listener);
      await entry.ready;
      return () => {
        if (
          !entry.listeners.delete(listener) ||
          entry.listeners.size > 0 ||
          subscriptions.get(key) !== entry
        )
          return;
        subscriptions.delete(key);
        entry.stop?.();
      };
    },
  };
}
