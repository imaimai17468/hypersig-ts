import { RedisClient } from "bun";
import type { Topic } from "../../src/index.js";
import { createRedisPubSub } from "../../src/redis.js";

/**
 * Connects a process to Redis with `Bun.RedisClient`: one connection for
 * commands and `PUBLISH`, and one in subscriber mode.
 */
export async function connectRedis<Event extends Topic>(
  url: string,
  channelPrefix?: string
) {
  const client = new RedisClient(url);
  await client.connect();
  const subscriber = await client.duplicate();
  const pubsub = createRedisPubSub<Event>({
    ...(channelPrefix !== undefined && { channelPrefix }),
    publish: (channel, message) => client.publish(channel, message),
    async subscribe(channel, onMessage) {
      const listener = () => onMessage();
      await subscriber.subscribe(channel, listener);
      return () => subscriber.unsubscribe(channel, listener);
    },
  });
  // Bun reconnects on its own but does not subscribe again, so a reconnect
  // means every subscription was lost. `onclose` reports a connection that
  // stopped reconnecting.
  let isClosing = false;
  subscriber.onconnect = subscriber.onclose = () => {
    if (!isClosing) pubsub.disconnected();
  };
  return {
    client,
    pubsub,
    close() {
      isClosing = true;
      subscriber.close();
      client.close();
    },
  };
}
