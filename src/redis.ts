import { shareTopicSubscriptions, topicKey } from "./topic.js";
import type { PubSub, Topic } from "./topic.js";

/**
 * The two Redis calls the adapter makes. Each Redis client connects them
 * differently, so the application writes them for the client it uses.
 */
export interface RedisPubSubOptions {
  /**
   * Send `message` on `channel` with `PUBLISH`, from a connection that is not
   * in subscriber mode. Resolve once Redis has accepted the command.
   */
  publish(channel: string, message: string): Promise<unknown>;
  /**
   * Subscribe to `channel` on a connection in subscriber mode and call
   * `onMessage` for each message on it. Resolve once Redis has confirmed the
   * subscription, with a function that ends it. Within one adapter, a channel
   * has at most one subscription in use, but it can be subscribed again
   * before ending the previous one has finished, so the returned function
   * must end only the subscription it came from.
   */
  subscribe(channel: string, onMessage: () => void): Promise<() => unknown>;
  /**
   * Put before each Topic's key to name its channel (default `"hypersig:"`).
   * Applications that share one Redis keep apart with different prefixes.
   */
  channelPrefix?: string;
}

export interface RedisPubSub<Event extends Topic> extends PubSub<Event> {
  /**
   * Report that the subscriber connection was lost. Every subscription made
   * so far, including one still waiting for Redis, ends and calls its
   * `onDisconnect`, so the live runtime subscribes again and re-reads the
   * views, which then show the changes published while the connection was
   * down. Call it from the client's connection error or close event.
   */
  disconnected(): void;
}

/**
 * Deliver publications between processes through Redis Pub/Sub. A message
 * reaches the processes subscribed when Redis receives it, at most once: one
 * published while a subscriber is disconnected never reaches it, and the
 * views on that process catch up only when `disconnected()` is called or
 * `reconcileIntervalMs` re-reads them.
 */
export function createRedisPubSub<Event extends Topic>(
  options: RedisPubSubOptions
): RedisPubSub<Event> {
  const prefix = options.channelPrefix ?? "hypersig:";
  const disconnects = new Set<() => void>();
  // Subscribers re-read the current value, so the message carries nothing.
  const message = "";

  const pubsub = shareTopicSubscriptions<Event>({
    async publish(event) {
      await options.publish(prefix + topicKey(event), message);
    },
    async subscribe(event, notify, onDisconnect) {
      const disconnect = () => onDisconnect?.();
      disconnects.add(disconnect);
      let unsubscribe: () => unknown;
      try {
        unsubscribe = await options.subscribe(prefix + topicKey(event), () =>
          notify()
        );
      } catch (error) {
        disconnects.delete(disconnect);
        throw error;
      }
      return () => {
        disconnects.delete(disconnect);
        Promise.resolve()
          .then(unsubscribe)
          .catch((error: unknown) => console.error(error));
      };
    },
  });

  return {
    publish: (event) => pubsub.publish(event),
    subscribe: (event, listener, onDisconnect) =>
      pubsub.subscribe(event, listener, onDisconnect),
    disconnected() {
      const lost = [...disconnects];
      disconnects.clear();
      for (const disconnect of lost) disconnect();
    },
  };
}
