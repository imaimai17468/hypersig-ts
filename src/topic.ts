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
  subscribe(event: Event, listener: () => void): Promise<() => void>;
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
