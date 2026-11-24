import { expect, it } from "vite-plus/test";
import type { EvaluationContext } from "./evaluate.js";
import { evaluate, formatText } from "./evaluate.js";
import type { ExprNode, JsonValue } from "./protocol.js";
import { isBindableAttribute, isExprNode, isStmtNode } from "./protocol.js";

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
