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
