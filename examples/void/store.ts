export const counterKeys = ["main", "other"] as const;
export type CounterKey = (typeof counterKeys)[number];

export interface CounterStore {
  read(key: CounterKey): number | Promise<number>;
  /** A fulfilled increment can be published to subscribers. */
  increment(key: CounterKey): number | Promise<number>;
}

export function createMemoryCounterStore(): CounterStore {
  const values: Record<CounterKey, number> = { main: 0, other: 0 };
  return {
    read: (key) => values[key],
    increment: (key) => ++values[key],
  };
}
