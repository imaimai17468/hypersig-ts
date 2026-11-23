import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Principal } from "./live.js";

type MaybePromise<Value> = Value | Promise<Value>;

export interface ActionIssue {
  message: string;
  field?: string;
}

export class ActionError extends Error {
  constructor(
    readonly status: 400 | 409 | 422,
    message: string
  ) {
    super(message);
  }
}

export type ActionFormResult<Output> =
  | { type: "success"; data: Output }
  | { type: "invalid"; values: FormData; issues: readonly ActionIssue[] }
  | { type: "rejected"; values: FormData; error: ActionError };

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
  /** Render or redirect a standard HTML form submission. */
  formResponse?(
    this: void,
    result: ActionFormResult<NoInfer<Output>>,
    request: Request,
    user: User
  ): MaybePromise<Response>;
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

function readIssues(issues: readonly StandardSchemaV1.Issue[]): ActionIssue[] {
  return issues.map(({ message, path }) => {
    const segment = path?.[0];
    const field = typeof segment === "object" ? segment.key : segment;
    return typeof field === "string" ? { message, field } : { message };
  });
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
      let values: FormData | undefined;
      try {
        if (type === "application/json") body = await c.req.raw.json();
        else {
          values = await c.req.raw.formData();
          body = readForm(values);
        }
      } catch {
        return c.json({ error: "body" }, 400);
      }
      const accept = c.req
        .header("Accept")
        ?.split(",")
        .map((entry) => entry.split(";", 1)[0]?.trim().toLowerCase());
      const form =
        values && accept?.includes("text/html") && definition.formResponse;
      const parsed = await definition.input["~standard"].validate(body);
      if (parsed.issues) {
        const issues = readIssues(parsed.issues);
        if (form && values)
          return form({ type: "invalid", values, issues }, c.req.raw, user);
        return c.json(
          {
            error: "input",
            issues: issues.map(({ message }) => message),
            fieldIssues: issues,
          },
          422
        );
      }
      if (!(await definition.authorize(parsed.value, user))) {
        return c.json({ error: "authorization" }, 403);
      }
      let value: Value;
      try {
        value = await definition.execute(parsed.value, user);
      } catch (error) {
        if (!(error instanceof ActionError)) throw error;
        if (form && values)
          return form({ type: "rejected", values, error }, c.req.raw, user);
        return c.json(
          { error: "action", message: error.message },
          error.status
        );
      }
      const result = await definition.output["~standard"].validate(value);
      if (result.issues) throw new Error(`Invalid output from Action ${name}`);
      if (form)
        return form({ type: "success", data: result.value }, c.req.raw, user);
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
    form(options: { resetOnSuccess?: boolean; reportSuccess?: boolean } = {}): {
      action: string;
      method: "post";
      "data-hs-form": string;
      "data-hs-reset-on-success"?: string;
      "data-hs-action-result"?: string;
    } {
      return {
        action: url,
        method: "post",
        "data-hs-form": "",
        ...(options.resetOnSuccess ? { "data-hs-reset-on-success": "" } : {}),
        ...(options.reportSuccess ? { "data-hs-action-result": "" } : {}),
      };
    },
  };
}
