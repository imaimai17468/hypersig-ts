import { Context } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";

const cookie = "hypersig-counter-session";
const lifetimeSeconds = 8 * 60 * 60;

export function createCounterSessions(secret: string, origin: string) {
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }
  return {
    async authenticate(request: Request) {
      const ticket = await getSignedCookie(
        new Context(request),
        secret,
        cookie
      );
      if (typeof ticket !== "string") return null;
      const [sessionId, expiration] = ticket.split("/");
      return sessionId && Number(expiration) > Date.now()
        ? { sessionId }
        : null;
    },
    async issue(context: Context) {
      const expiry = Date.now() + lifetimeSeconds * 1000;
      const ticket = `${crypto.randomUUID()}/${expiry}`;
      await setSignedCookie(context, cookie, ticket, secret, {
        maxAge: lifetimeSeconds,
        path: "/",
        httpOnly: true,
        sameSite: "Strict",
        secure: origin.startsWith("https://"),
      });
    },
  };
}
