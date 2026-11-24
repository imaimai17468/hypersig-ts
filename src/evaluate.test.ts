import { expect, it } from "vite-plus/test";
import type { EvaluationContext } from "./evaluate.js";
import { evaluate, formatText } from "./evaluate.js";
import type { ExprNode, JsonValue } from "./protocol.js";
import {
  isBindableAttribute,
  isBindableCustomAttribute,
  isCustomElementName,
  isCustomEventName,
  isExprNode,
  isStmtNode,
} from "./protocol.js";

function createContext(
  values: Record<string, JsonValue>,
  extra: Partial<EvaluationContext> = {}
): EvaluationContext {
  return {
    read: (path) => values[path.join(".")],
    uuid: () => "id-1",
    ...extra,
  };
}

const n: ExprNode = ["sig", ["g", "n"]];

it("evaluates arithmetic, comparison, logic and conditions", () => {
  const context = createContext({ "g.n": 2 });
  expect(evaluate(["add", ["lit", 1], n], context)).toBe(3);
  expect(evaluate(["sub", n, ["lit", 1]], context)).toBe(1);
  expect(evaluate(["mul", n, ["lit", 3]], context)).toBe(6);
  expect(evaluate(["gt", n, ["lit", 1]], context)).toBe(true);
  expect(evaluate(["ge", n, ["lit", 3]], context)).toBe(false);
  expect(evaluate(["lt", n, ["lit", 3]], context)).toBe(true);
  expect(evaluate(["le", n, ["lit", 1]], context)).toBe(false);
  expect(evaluate(["eq", n, ["lit", 2]], context)).toBe(true);
  expect(evaluate(["ne", n, ["lit", 2]], context)).toBe(false);
  expect(
    evaluate(["eq", ["lit", { a: [1] }], ["lit", { a: [1] }]], context)
  ).toBe(true);
  expect(evaluate(["ne", ["lit", [1]], ["lit", [2]]], context)).toBe(true);
  expect(evaluate(["not", ["lit", false]], context)).toBe(true);
  expect(evaluate(["and", ["lit", true], ["lit", false]], context)).toBe(false);
  expect(evaluate(["or", ["lit", false], ["lit", true]], context)).toBe(true);
  expect(
    evaluate(["if", ["lit", false], ["lit", "a"], ["lit", "b"]], context)
  ).toBe("b");
  expect(
    evaluate(["if", ["lit", true], ["lit", "a"], ["lit", "b"]], context)
  ).toBe("a");
  expect(evaluate(["concat", ["lit", "v"], ["lit", "1"]], context)).toBe("v1");
  expect(evaluate(["concat", ["lit", "v"], ["lit", 1]], context)).toBe("v1");
});

it("reads output fields and generates ids", () => {
  const context = createContext({}, { output: { revision: 4 } });
  expect(evaluate(["get", ["output"], "revision"], context)).toBe(4);
  expect(evaluate(["get", ["output"], "missing"], context)).toBeNull();
  for (const key of ["constructor", "toString", "__proto__"]) {
    expect(evaluate(["get", ["lit", {}], key], context)).toBeNull();
  }
  expect(evaluate(["uuid"], context)).toBe("id-1");
  expect(evaluate(["output"], createContext({}))).toBeNull();
});

it("returns null for mismatched types and unknown paths", () => {
  const context = createContext({});
  expect(evaluate(["gt", ["lit", "a"], ["lit", 1]], context)).toBeNull();
  expect(evaluate(["add", ["lit", "a"], ["lit", 1]], context)).toBeNull();
  expect(evaluate(["sig", ["g", "unknown"]], context)).toBeNull();
  expect(evaluate(["get", ["lit", 5], "x"], context)).toBeNull();
  expect(evaluate(["concat", ["lit", {}], ["lit", "a"]], context)).toBeNull();
});

it("formats values as text", () => {
  expect(formatText(null)).toBe("");
  expect(formatText(true)).toBe("true");
  expect(formatText(false)).toBe("false");
  expect(formatText(3)).toBe("3");
  expect(formatText("a")).toBe("a");
  expect(formatText([1, "a"])).toBe('[1,"a"]');
  expect(formatText({ a: 1 })).toBe('{"a":1}');
});

it("validates nodes from untrusted attributes", () => {
  expect(isExprNode(["eval", "x"])).toBe(false);
  expect(isExprNode(["add", ["lit", 1]])).toBe(false);
  expect(isExprNode(["sig", "a"])).toBe(false);
  expect(isExprNode(["sig", ["a", 1]])).toBe(false);
  expect(isExprNode(["get", ["output"], 1])).toBe(false);
  expect(isExprNode(["not", ["eval", "x"]])).toBe(false);
  expect(isExprNode("lit")).toBe(false);
  expect(isExprNode(["add", ["lit", 1], ["lit", 2]])).toBe(true);
  expect(isExprNode(["lit", { a: [1, null] }])).toBe(true);
  expect(isExprNode(["sig", ["g", "n"]])).toBe(true);
  expect(isExprNode(["if", ["lit", true], ["lit", 1], ["lit", 2]])).toBe(true);
  expect(isExprNode(["get", ["output"], "a"])).toBe(true);
  expect(isExprNode(["uuid"])).toBe(true);

  expect(isStmtNode(["set", "a", ["lit", 1]])).toBe(false);
  expect(isStmtNode(["set", ["a"], ["eval", 1]])).toBe(false);
  expect(isStmtNode(["toggle", "a"])).toBe(false);
  expect(isStmtNode(["focus", 1])).toBe(false);
  expect(isStmtNode(["call", "/a", { x: ["eval"] }, [], []])).toBe(false);
  expect(isStmtNode(["call", "/a", {}, [["bad"]], []])).toBe(false);
  expect(isStmtNode(["call", "/a", {}, [], [["bad"]]])).toBe(false);
  expect(isStmtNode(["set", ["a"], ["lit", 1]])).toBe(true);
  expect(isStmtNode(["toggle", ["a"]])).toBe(true);
  expect(isStmtNode(["focus", "ref-1"])).toBe(true);
  expect(isStmtNode(["focus-key", "ref-1", ["lit", "a"]])).toBe(true);
  expect(isStmtNode(["focus-key", "ref-1"])).toBe(false);
  expect(isStmtNode(["focus-key", 1, ["lit", "a"]])).toBe(false);
  expect(isStmtNode(["focus-key", "ref-1", ["eval"]])).toBe(false);
  expect(isStmtNode(["after", "t-1", 0, []])).toBe(true);
  expect(isStmtNode(["after", "t-1", 500, [["toggle", ["a"]]]])).toBe(true);
  expect(isStmtNode(["after", "t-1", -1, []])).toBe(false);
  expect(isStmtNode(["after", "t-1", 1.5, []])).toBe(false);
  expect(isStmtNode(["after", "t-1", "500", []])).toBe(false);
  expect(isStmtNode(["after", 1, 500, []])).toBe(false);
  expect(isStmtNode(["after", "t-1", 500, [["bad"]]])).toBe(false);
  expect(isStmtNode(["after", "t-1", 500])).toBe(false);
  expect(isStmtNode(["cancel", "t-1"])).toBe(true);
  expect(isStmtNode(["cancel", 1])).toBe(false);
  expect(isStmtNode(["cancel", "t-1", 0])).toBe(false);
  expect(
    isStmtNode([
      "call",
      "/a",
      { x: ["lit", 1] },
      [["toggle", ["a"]]],
      [["focus", "r"]],
    ])
  ).toBe(true);
});

it("allows only listed attributes", () => {
  expect(isBindableAttribute("aria-pressed")).toBe(true);
  expect(isBindableAttribute("disabled")).toBe(true);
  expect(isBindableAttribute("data-completed")).toBe(true);
  for (const name of [
    "href",
    "src",
    "onclick",
    "style",
    "data-hs-action",
    "data-",
    "data-HS-action",
    "Data-hs-x",
    "ARIA-PRESSED",
  ]) {
    expect(isBindableAttribute(name)).toBe(false);
  }
});

/** An `if` chain `levels` nodes deep that evaluates to the innermost literal. */
function nestExpr(levels: number): ExprNode {
  let node: ExprNode = ["lit", "deep"];
  for (let level = 1; level < levels; level += 1) {
    node = ["if", ["lit", true], node, ["lit", "shallow"]];
  }
  return node;
}

/** A `call` statement whose success handlers nest `levels` statements deep. */
function nestStmt(levels: number): unknown {
  let stmt: unknown = ["toggle", ["a"]];
  for (let level = 1; level < levels; level += 1) {
    stmt = ["call", "/a", {}, [stmt], []];
  }
  return stmt;
}

it("rejects and stops evaluating nodes nested deeper than 64 levels", () => {
  expect(isExprNode(nestExpr(64))).toBe(true);
  expect(isExprNode(nestExpr(65))).toBe(false);
  expect(isExprNode(["lit", JSON.parse("[".repeat(64) + "]".repeat(64))])).toBe(
    true
  );
  expect(isExprNode(["lit", JSON.parse("[".repeat(65) + "]".repeat(65))])).toBe(
    false
  );
  expect(isStmtNode(nestStmt(64))).toBe(true);
  expect(isStmtNode(nestStmt(65))).toBe(false);
  // The expression inside a statement counts toward the same depth.
  expect(isStmtNode(["set", ["a"], nestExpr(63)])).toBe(true);
  expect(isStmtNode(["set", ["a"], nestExpr(64)])).toBe(false);

  const context = createContext({});
  expect(evaluate(nestExpr(64), context)).toBe("deep");
  expect(evaluate(nestExpr(65), context)).toBeNull();
  expect(() => evaluate(nestExpr(100_000), context)).not.toThrow();
});

it("reads the detail of a custom event", () => {
  expect(evaluate(["detail"], createContext({}, { detail: 4 }))).toBe(4);
  expect(
    evaluate(["get", ["detail"], "x"], createContext({}, { detail: { x: 1 } }))
  ).toBe(1);
  expect(evaluate(["detail"], createContext({}))).toBeNull();
  expect(isExprNode(["detail"])).toBe(true);
  expect(isExprNode(["detail", 1])).toBe(false);
});

it("recognizes custom element names", () => {
  for (const name of ["star-rating", "x-1", "a-b.c_d", "my-", "font-face-x"]) {
    expect(isCustomElementName(name)).toBe(true);
  }
  for (const name of [
    "rating",
    "Star-rating",
    "star-Rating",
    "1-a",
    "-a",
    "a-b!",
    "",
    "annotation-xml",
    "color-profile",
    "font-face",
    "font-face-src",
    "font-face-uri",
    "font-face-format",
    "font-face-name",
    "missing-glyph",
  ]) {
    expect(isCustomElementName(name)).toBe(false);
  }
});

it("allows custom element attributes other than handlers, style and runtime attributes", () => {
  for (const name of ["value", "max", "aria-label", "data-x"]) {
    expect(isBindableCustomAttribute(name)).toBe(true);
  }
  for (const name of [
    "onrate",
    "onclick",
    "style",
    "id",
    "data-hs-x",
    "Value",
    "",
  ]) {
    expect(isBindableCustomAttribute(name)).toBe(false);
  }
});

it("recognizes custom event names", () => {
  for (const name of ["rate", "hover:star", "a.b_c-d", "x1"]) {
    expect(isCustomEventName(name)).toBe(true);
  }
  for (const name of [
    "Rate",
    "rAte",
    "1rate",
    ":rate",
    "rate!",
    "",
    "click",
    "input",
    "change",
    "submit",
  ]) {
    expect(isCustomEventName(name)).toBe(false);
  }
});

const ctx = createContext({});
const lit = (value: JsonValue): ExprNode => ["lit", value];

it("evaluates length of strings and arrays, and 0 for other values", () => {
  expect(evaluate(["length", lit("héllo")], ctx)).toBe(5);
  expect(evaluate(["length", lit("")], ctx)).toBe(0);
  expect(evaluate(["length", lit(["a", "b"])], ctx)).toBe(2);
  expect(evaluate(["length", lit(7)], ctx)).toBe(0);
  expect(evaluate(["length", lit(null)], ctx)).toBe(0);
  expect(evaluate(["length", lit({ length: 3 })], ctx)).toBe(0);
});

it("evaluates trim and lower, and '' for non-strings", () => {
  expect(evaluate(["trim", lit("  a b ")], ctx)).toBe("a b");
  expect(evaluate(["trim", lit(5)], ctx)).toBe("");
  expect(evaluate(["trim", lit(null)], ctx)).toBe("");
  expect(evaluate(["lower", lit("ÀB")], ctx)).toBe("àb");
  expect(evaluate(["lower", lit(["A"])], ctx)).toBe("");
});

it("evaluates includes, and false unless both sides are strings", () => {
  expect(evaluate(["includes", lit("Hello"), lit("ell")], ctx)).toBe(true);
  expect(evaluate(["includes", lit("Hello"), lit("ELL")], ctx)).toBe(false);
  expect(evaluate(["includes", lit("Hello"), lit("")], ctx)).toBe(true);
  expect(evaluate(["includes", lit(5), lit("5")], ctx)).toBe(false);
  expect(evaluate(["includes", lit("5"), lit(5)], ctx)).toBe(false);
  expect(evaluate(["includes", lit(null), lit("")], ctx)).toBe(false);
});

it("evaluates clamp, with min for min > max and non-numbers", () => {
  const clamp = (v: JsonValue, min: JsonValue, max: JsonValue) =>
    evaluate(["clamp", lit(v), lit(min), lit(max)], ctx);
  expect(clamp(5, 0, 3)).toBe(3);
  expect(clamp(-1, 0, 3)).toBe(0);
  expect(clamp(2, 0, 3)).toBe(2);
  expect(clamp(5, 4, 1)).toBe(4);
  expect(clamp("5", 1, 3)).toBe(1);
  expect(clamp(null, 1, 3)).toBe(1);
  expect(clamp(5, 1, "3")).toBe(1);
  expect(clamp(5, "1", 3)).toBe(0);
});

it("evaluates mod as a non-negative remainder, 0 for n = 0 and non-numbers", () => {
  const mod = (v: JsonValue, n: JsonValue) =>
    evaluate(["mod", lit(v), lit(n)], ctx);
  expect(mod(4, 3)).toBe(1);
  expect(mod(-1, 3)).toBe(2);
  expect(mod(3, 3)).toBe(0);
  expect(mod(-3, 3)).toBe(0);
  expect(mod(5, 0)).toBe(0);
  expect(mod("4", 3)).toBe(0);
  expect(mod(4, null)).toBe(0);
});

it("evaluates at, with the fallback outside the array or for a bad index", () => {
  const at = (list: JsonValue, index: JsonValue) =>
    evaluate(["at", lit(list), lit(index), lit("fb")], ctx);
  expect(at(["a", "b"], 1)).toBe("b");
  expect(at(["a", "b"], 0)).toBe("a");
  expect(at(["a", "b"], 3)).toBe("fb");
  expect(at(["a", "b"], 2)).toBe("fb");
  expect(at(["a", "b"], -1)).toBe("fb");
  expect(at(["a", "b"], 0.5)).toBe("fb");
  expect(at(["a", "b"], "1")).toBe("fb");
  expect(at("ab", 0)).toBe("fb");
  expect(at(null, 0)).toBe("fb");
  expect(at({ "0": "a" }, 0)).toBe("fb");
});

it("accepts the new nodes only with the right arity", () => {
  expect(isExprNode(["length", lit("a")])).toBe(true);
  expect(isExprNode(["includes", lit("a"), lit("b")])).toBe(true);
  expect(isExprNode(["clamp", lit(1), lit(0), lit(2)])).toBe(true);
  expect(isExprNode(["at", lit([]), lit(0), lit(null)])).toBe(true);
  expect(isExprNode(["length"])).toBe(false);
  expect(isExprNode(["trim", lit("a"), lit("b")])).toBe(false);
  expect(isExprNode(["mod", lit(1)])).toBe(false);
  expect(isExprNode(["clamp", lit(1), lit(0)])).toBe(false);
  expect(isExprNode(["at", lit([]), lit(0)])).toBe(false);
  expect(isExprNode(["lower", ["bogus"]])).toBe(false);
});
