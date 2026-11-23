import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Principal } from "./live.js";

type MaybePromise<Value> = Value | Promise<Value>;

export interface ActionDefinition<
  Wire,
  Input,
  Value,
  Output,
  User extends Principal,
> {
  input: StandardSchemaV1<Wire, Input>;
  output: StandardSchemaV1<Value, Output>;
  authorize(input: NoInfer<Input>, user: User): MaybePromise<boolean>;
  execute(input: NoInfer<Input>, user: User): MaybePromise<NoInfer<Value>>;
}

type FormValue = FormDataEntryValue | FormDataEntryValue[];
type FormFieldName<Input> = Input extends readonly unknown[]
  ? never
  : Input extends object
    ? `${Extract<keyof Input, string | number>}`
    : never;

function readForm(form: FormData): Record<string, FormValue> {
  const fields = new Map<string, FormValue>();
  for (const [name, value] of form) {
    const previous = fields.get(name);
    if (Array.isArray(previous)) previous.push(value);
    else fields.set(name, previous === undefined ? value : [previous, value]);
  }
  return Object.fromEntries(fields);
}

async function readInput(request: Request, type: string): Promise<unknown> {
  if (type === "application/json") return request.json();
  return readForm(await request.formData());
}

export function registerAction<
  Wire,
  Input,
  Value,
  Output,
  User extends Principal,
>(
  routes: Hono,
  basePath: string,
  name: string,
  origin: string,
  authenticate: (request: Request) => MaybePromise<User | null>,
  definition: ActionDefinition<Wire, Input, Value, Output, User>
) {
  const path = `/actions/${name}`;
  const url = basePath + path;
  routes.post(
    path,
    async (c, next) => {
      c.header("Cache-Control", "no-store");
      if (c.req.header("Origin") !== origin) {
        return c.json({ error: "origin" }, 403);
      }
      await next();
    },
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: "size" }, 413),
    }),
    async (c) => {
      const user = await authenticate(c.req.raw);
      if (!user) return c.json({ error: "authentication" }, 401);
      const type = c.req
        .header("Content-Type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      if (
        type !== "application/json" &&
        type !== "multipart/form-data" &&
        type !== "application/x-www-form-urlencoded"
      ) {
        return c.json({ error: "media-type" }, 415);
      }
      let body: unknown;
      try {
        body = await readInput(c.req.raw, type);
      } catch {
        return c.json({ error: "body" }, 400);
      }
      const parsed = await definition.input["~standard"].validate(body);
      if (parsed.issues)
        return c.json(
          {
            error: "input",
            issues: parsed.issues.map(({ message }) => message),
          },
          422
        );
      if (!(await definition.authorize(parsed.value, user))) {
        return c.json({ error: "authorization" }, 403);
      }
      const value = await definition.execute(parsed.value, user);
      const result = await definition.output["~standard"].validate(value);
      if (result.issues) throw new Error(`Invalid output from Action ${name}`);
      return c.json({ data: result.value });
    }
  );

  return {
    url,
    bind(input: Wire) {
      const json = JSON.stringify(input);
      if (json === undefined)
        throw new TypeError("Action input must serialize to JSON");
      return { "data-hs-action": url, "data-hs-input": json };
    },
    /** Check a top-level HTML field name against the schema's input type. */
    field<Name extends FormFieldName<Wire>>(name: Name): Name {
      return name;
    },
    form(options: { resetOnSuccess?: boolean } = {}): {
      action: string;
      method: "post";
      "data-hs-form": string;
      "data-hs-reset-on-success"?: string;
    } {
      return {
        action: url,
        method: "post",
        "data-hs-form": "",
        ...(options.resetOnSuccess ? { "data-hs-reset-on-success": "" } : {}),
      };
    },
  };
}
