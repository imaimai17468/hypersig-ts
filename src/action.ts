import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Principal } from "./live.js";
import type { ExprNode, JsonValue, StmtNode } from "./protocol.js";
import { outletAttributes, signalAttributes } from "./protocol.js";
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

/** Attributes for an input element, derived from the input schema. */
export interface FieldControl<Name extends string> {
  name: Name;
  required?: true;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
}

export interface JsonSchemaOptions {
  /** Passed to the schema library when it converts an input schema. */
  libraryOptions?: Record<string, unknown>;
}

export interface ActionDefinition<
  Wire,
  Input,
  Value,
  Output,
  User extends Principal,
  Schema = unknown,
> {
  input: StandardSchemaV1<Wire, Input> & Schema;
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
  // Defining each entry keeps a field named `__proto__` as a key.
  return Object.fromEntries(
    Object.entries(input).flatMap(([field, value]) =>
      value === undefined ? [] : [[field, nodeOf(value)]]
    )
  );
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

type JsonSchemaObject = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonSchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberAt(schema: JsonSchemaObject, key: string): number | undefined {
  const value = schema[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * JSON Schema patterns are unanchored ECMAScript regular expressions with the
 * `u` flag. A pattern that fails to compile cannot be shown to reject "", so it
 * does not count.
 */
function patternRejectsEmptyString(pattern: string): boolean {
  try {
    return !new RegExp(pattern, "u").test("");
  } catch {
    return false;
  }
}

function rejectsEmptyString(property: JsonSchemaObject): boolean {
  const minLength = numberAt(property, "minLength");
  const pattern = property["pattern"];
  const choices = property["enum"];
  return (
    (minLength !== undefined && minLength >= 1) ||
    (typeof pattern === "string" && patternRejectsEmptyString(pattern)) ||
    (Array.isArray(choices) && !choices.includes(""))
  );
}

function endsWithUnescapedDollar(pattern: string): boolean {
  if (!pattern.endsWith("$")) return false;
  let backslashes = 0;
  for (let i = pattern.length - 2; i >= 0 && pattern[i] === "\\"; i--) {
    backslashes++;
  }
  return backslashes % 2 === 0;
}

function hasTopLevelAlternation(pattern: string): boolean {
  let classDepth = 0;
  let groupDepth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i];
    if (character === "\\") i++;
    else if (character === "[") classDepth++;
    else if (character === "]" && classDepth > 0) classDepth--;
    else if (classDepth > 0) continue;
    else if (character === "(") groupDepth++;
    else if (character === ")" && groupDepth > 0) groupDepth--;
    else if (character === "|" && groupDepth === 0) return true;
  }
  return false;
}

function compilesAsPatternAttribute(pattern: string): boolean {
  try {
    new RegExp(`^(?:${pattern})$`, "v");
    return true;
  } catch {
    return false;
  }
}

/**
 * The browser wraps a `pattern` attribute as `^(?:pattern)$` with the `v`
 * flag. A pattern is passed through only when that wrapping matches the same
 * strings as the schema's own expression: anchored at both ends, with no
 * top-level alternation, and valid under `v`.
 */
function isBrowserEquivalentPattern(pattern: string): boolean {
  return (
    pattern.startsWith("^") &&
    endsWithUnescapedDollar(pattern) &&
    !hasTopLevelAlternation(pattern) &&
    compilesAsPatternAttribute(pattern)
  );
}

/** Derived attributes never make the browser stricter than the server. */
function deriveControl<Name extends string>(
  name: Name,
  schema: JsonSchemaObject
): FieldControl<Name> {
  const { properties, required } = schema;
  const property = isRecord(properties) ? properties[name] : undefined;
  const control: FieldControl<Name> = { name };
  if (!isRecord(property)) return control;
  if (
    Array.isArray(required) &&
    required.includes(name) &&
    property["type"] !== "boolean" &&
    rejectsEmptyString(property)
  ) {
    control.required = true;
  }
  const minLength = numberAt(property, "minLength");
  const maxLength = numberAt(property, "maxLength");
  const min = numberAt(property, "minimum");
  const max = numberAt(property, "maximum");
  const pattern = property["pattern"];
  if (minLength !== undefined) control.minLength = minLength;
  if (maxLength !== undefined) control.maxLength = maxLength;
  if (typeof pattern === "string" && isBrowserEquivalentPattern(pattern)) {
    control.pattern = pattern;
  }
  if (min !== undefined) control.min = min;
  if (max !== undefined) control.max = max;
  return control;
}

/** `control()` exists only when the input schema converts to JSON Schema. */
type ControlMethods<Schema, Wire> = Schema extends StandardJSONSchemaV1
  ? {
      /**
       * Attributes for the input named `name`, derived from the input schema's
       * JSON Schema: `required`, `minLength`, `maxLength`, `min`, `max`, and
       * `pattern`. None makes the browser stricter than the server:
       * `required` appears only when the schema rejects the empty string, and
       * `pattern` only when it is anchored with `^` and `$`, has no top-level
       * `|`, and is valid under the `v` flag. The schema is converted on the
       * first call; a conversion error names this Action. Only a top-level
       * object schema is read. Anything else yields `name` alone.
       */
      control<Name extends FormFieldName<Wire>>(name: Name): FieldControl<Name>;
    }
  : unknown;

function createActionMethods<Wire, Output>(url: string, name: string) {
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
     * Marks the element inside this Action's form that shows the schema's
     * message for one field after a failed submission.
     */
    fieldError<Name extends FormFieldName<Wire>>(
      name: Name
    ): { [outletAttributes.fieldError]: Name } {
      return { [outletAttributes.fieldError]: name };
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

export function registerAction<
  Wire,
  Input,
  Value,
  Output,
  User extends Principal,
  Schema = unknown,
>(
  routes: Hono,
  basePath: string,
  name: string,
  origin: string,
  authenticate: (request: Request) => MaybePromise<User | null>,
  definition: ActionDefinition<Wire, Input, Value, Output, User, Schema>,
  jsonSchema?: JsonSchemaOptions
): ReturnType<typeof createActionMethods<Wire, Output>> &
  ControlMethods<Schema, Wire>;
export function registerAction<
  Wire,
  Input,
  Value,
  Output,
  User extends Principal,
  Schema,
>(
  routes: Hono,
  basePath: string,
  name: string,
  origin: string,
  authenticate: (request: Request) => MaybePromise<User | null>,
  definition: ActionDefinition<Wire, Input, Value, Output, User, Schema>,
  jsonSchema: JsonSchemaOptions = {}
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

  let inputSchema: JsonSchemaObject | undefined;
  const readInputSchema = (): JsonSchemaObject => {
    if (inputSchema) return inputSchema;
    const standard: unknown = definition.input["~standard"];
    const converter =
      isRecord(standard) && isRecord(standard["jsonSchema"])
        ? standard["jsonSchema"]
        : undefined;
    const convert = converter?.["input"];
    if (typeof convert !== "function") {
      throw new Error(`Action ${name} has no JSON Schema conversion`);
    }
    try {
      const converted: unknown = convert.call(converter, {
        target: "draft-2020-12",
        libraryOptions: jsonSchema.libraryOptions,
      });
      inputSchema = isRecord(converted) ? converted : {};
    } catch (error) {
      throw new Error(
        `Action ${name}: converting the input schema to JSON Schema failed. ` +
          `Skip unsupported parts with jsonSchema.libraryOptions in createHypersig`,
        { cause: error }
      );
    }
    return inputSchema;
  };

  const methods = createActionMethods<Wire, Output>(url, name);
  const standard: unknown = definition.input["~standard"];
  if (!isRecord(standard) || !isRecord(standard["jsonSchema"])) return methods;
  return {
    ...methods,
    control: <Name extends string>(controlName: Name): FieldControl<Name> =>
      deriveControl(controlName, readInputSchema()),
  };
}
