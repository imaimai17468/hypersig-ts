import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Principal } from "./live.js";
import type { ExprNode, JsonValue, StmtNode } from "./protocol.js";
import { signalAttributes } from "./protocol.js";
import type { Expr } from "./signal.js";
import { exprOf, listStmts, nodeOf, serializeStmts } from "./signal.js";

export type { JsonValue } from "./protocol.js";

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

type BindInput<Wire> = [Wire] extends [JsonValue]
  ? Wire
  : "This Action's input is not JSON. Submit it with form() instead";

type CallInput<Wire> = [Wire] extends [JsonValue]
  ? { [K in keyof Wire]: Wire[K] | Expr<Extract<Wire[K], JsonValue>> }
  : "This Action's input is not JSON. Submit it with form() instead";

type Statements = StmtNode | readonly StmtNode[];

/** An Action's output as an expression, or `never` when it is not JSON. */
type OutputExpr<Output> = [Output] extends [JsonValue] ? Expr<Output> : never;

export interface ResultHandlers<Output> {
  /** Runs when the Action succeeds. `output` is the Action's output. */
  onSuccess?(this: void, output: OutputExpr<Output>): Statements;
  /** Runs when the Action fails. */
  onError?: Statements;
}

function outputExprOf<Output>(): OutputExpr<Output>;
function outputExprOf() {
  return exprOf<JsonValue>(["output"]);
}

/** Turns call input into expression nodes, leaving out omitted fields. */
function nodesOfCallInput<Wire>(
  input: CallInput<Wire>
): Record<string, ExprNode>;
function nodesOfCallInput(
  input: Readonly<Record<string, Parameters<typeof nodeOf>[0] | undefined>>
) {
  const nodes: Record<string, ExprNode> = {};
  for (const [field, value] of Object.entries(input)) {
    if (value !== undefined) nodes[field] = nodeOf(value);
  }
  return nodes;
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

  const callSuccess = (
    onSuccess: NonNullable<ResultHandlers<Output>["onSuccess"]>
  ): Statements => onSuccess(outputExprOf<Output>());

  return {
    url,
    /** Sends the input as JSON, so the schema's input type must be JSON. */
    bind(input: BindInput<Wire>) {
      return {
        "data-hs-action": url,
        "data-hs-input": JSON.stringify(input),
      };
    },
    /**
     * A statement that sends the input, evaluating signal values in the
     * browser when it runs. The input type must be JSON.
     */
    call(
      input: CallInput<Wire>,
      options: ResultHandlers<Output> = {}
    ): StmtNode {
      return [
        "call",
        url,
        nodesOfCallInput<Wire>(input),
        options.onSuccess ? listStmts(callSuccess(options.onSuccess)) : [],
        options.onError ? listStmts(options.onError) : [],
      ];
    },
    /** True in the browser while a request to this Action is in flight. */
    pending(): Expr<boolean> {
      return exprOf<boolean>(["sig", ["$pending", url]]);
    },
    /** True in the browser when a saved draft was restored for this Action. */
    draftRestored(): Expr<boolean> {
      return exprOf<boolean>(["sig", ["$restored", url]]);
    },
    /** Check a top-level HTML field name against the schema's input type. */
    field<Name extends FormFieldName<Wire>>(name: Name): Name {
      return name;
    },
    /**
     * Names a field and keeps its value across a live registration reset. The
     * draft is restored only into a form created with `form({ draft: true })`.
     */
    draft<Name extends FormFieldName<Wire>>(
      name: Name
    ): { name: Name; "data-hs-draft": "" } {
      return { name, "data-hs-draft": "" };
    },
    /**
     * `draft` keys the saved draft by this Action's name. When two forms on a
     * page set it for the same Action, only the first one keeps its draft.
     */
    form(
      options: ResultHandlers<Output> & {
        resetOnSuccess?: boolean;
        reportSuccess?: boolean;
        draft?: boolean;
        /** Runs in the browser, before the submit request is sent. */
        onSubmit?: Statements;
      } = {}
    ): {
      action: string;
      method: "post";
      "data-hs-form": string;
      "data-hs-reset-on-success"?: string;
      "data-hs-action-result"?: string;
      "data-hs-draft-form"?: string;
      "data-hs-on-success"?: string;
      "data-hs-on-error"?: string;
      "data-hs-on-submit"?: string;
    } {
      return {
        action: url,
        method: "post",
        "data-hs-form": "",
        ...(options.resetOnSuccess ? { "data-hs-reset-on-success": "" } : {}),
        ...(options.reportSuccess ? { "data-hs-action-result": "" } : {}),
        ...(options.draft ? { "data-hs-draft-form": name } : {}),
        ...(options.onSuccess
          ? {
              [signalAttributes.onSuccess]: serializeStmts(
                callSuccess(options.onSuccess)
              ),
            }
          : {}),
        ...(options.onError
          ? { [signalAttributes.onError]: serializeStmts(options.onError) }
          : {}),
        ...(options.onSubmit
          ? { [signalAttributes.onSubmit]: serializeStmts(options.onSubmit) }
          : {}),
      };
    },
  };
}
