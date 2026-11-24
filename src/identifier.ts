type CharsOf<
  Text extends string,
  Found extends string = never,
> = Text extends `${infer Char}${infer Rest}`
  ? CharsOf<Rest, Found | Char>
  : Found;

type IdentifierChar =
  CharsOf<"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-">;

type IsIdentifier<
  Text extends string,
  Seen extends unknown[] = [],
> = Text extends ""
  ? Seen extends []
    ? false
    : true
  : Seen["length"] extends 64
    ? false
    : Text extends `${IdentifierChar}${infer Rest}`
      ? IsIdentifier<Rest, [...Seen, unknown]>
      : false;

/**
 * Accepts a string literal of 1 to 64 letters, digits, `_`, or `-`, and
 * resolves to a message type that names the rule otherwise.
 */
export type Identifier<Text extends string> = string extends Text
  ? "Use a string literal"
  : IsIdentifier<Text> extends true
    ? Text
    : "Use 1 to 64 letters, digits, _ or -";

export const identifierPattern = /^[a-zA-Z0-9_-]{1,64}$/;

type LowercaseLetter = CharsOf<"abcdefghijklmnopqrstuvwxyz">;

type IsMadeOf<Text extends string, Allowed extends string> = Text extends ""
  ? true
  : Text extends `${Allowed}${infer Rest}`
    ? IsMadeOf<Rest, Allowed>
    : false;

type StartsLowercase<
  Text extends string,
  Allowed extends string,
> = Text extends `${LowercaseLetter}${infer Rest}`
  ? IsMadeOf<Rest, Allowed>
  : false;

type CustomEventChar = LowercaseLetter | CharsOf<"0123456789-.:_">;

type CustomAttributeChar = LowercaseLetter | CharsOf<"0123456789-._">;

/**
 * Whether a literal is a custom event name: a lowercase letter followed by
 * lowercase letters, digits, `-`, `.`, `:` or `_`, and not an event the
 * runtime delegates (`click`, `input`, `change` or `submit`).
 */
export type IsCustomEventName<Name extends string> = string extends Name
  ? false
  : Name extends "click" | "input" | "change" | "submit"
    ? false
    : StartsLowercase<Name, CustomEventChar>;

/**
 * Whether a literal is an attribute name a custom element may have bound: a
 * lowercase letter followed by lowercase letters, digits, `-`, `.` or `_`,
 * and not an event handler (`on*`), `style`, `id`, or a runtime `data-hs-*`
 * name.
 */
export type IsCustomAttributeName<Name extends string> = string extends Name
  ? false
  : Name extends `on${string}` | "style" | "id" | `data-hs-${string}`
    ? false
    : StartsLowercase<Name, CustomAttributeChar>;

/**
 * A custom element name that starts with a lowercase letter, holds a `-`, and
 * has no uppercase letter. TypeScript cannot check the other characters
 * without inferring the literal, so `customElement` checks them when called.
 */
export type CustomTagName =
  `${LowercaseLetter}${Lowercase<string>}-${Lowercase<string>}`;
