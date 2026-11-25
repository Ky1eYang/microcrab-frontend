import { expect, test } from "@playwright/test";
import { formatJson } from "../src/features/content-inspection/format";
import { scanJson } from "../src/features/content-inspection/json-lexemes";
import {
  copyJsonNode,
  readChildren,
  readerText,
  readJsonDocument,
  stringWindow,
  structuredJson,
} from "../src/features/content-inspection/json-reader-source";
import { describeLocalJs } from "../src/features/content-inspection/local-js-diagnostics";

const signal = () => new AbortController().signal;

test("shared scanner preserves lexical source, duplicate keys and decoded string copy", async () => {
  const source =
    ' {"a.b" : {"x":900719925474099312345, "x": -0,"x":1.00000000000000001E-400},"a\\u002eb":"line\\n\\uD83D\\uDE02","empty":{},"zero":0,"null":null} \n';
  const document = await readJsonDocument(source, signal());
  const children = await readChildren(document, document.root, 0, 10, signal());
  expect(children).toHaveLength(5);
  expect(await copyJsonNode(document, children[0], signal())).toBe(
    '{"x":900719925474099312345, "x": -0,"x":1.00000000000000001E-400}',
  );
  expect(await copyJsonNode(document, children[1], signal())).toBe("line\n😂");
  expect(await copyJsonNode(document, children[2], signal())).toBe("{}");
  expect(await copyJsonNode(document, children[3], signal())).toBe("0");
  expect(await copyJsonNode(document, children[4], signal())).toBe("null");
  expect(await copyJsonNode(document, document.root, signal())).toBe(
    source.trim(),
  );
  const paths: (string | number)[][] = [];
  expect(
    formatJson(source, (path, lexeme) => {
      paths.push([...path]);
      return lexeme;
    }),
  ).toContain('"a\\u002eb": "line\\n\\uD83D\\uDE02"');
  expect(paths).toEqual([["a.b"]]);
  const withArrayPath =
    '{"rows":[{"value":"first"},{"value":"second"}],"outside":"end"}';
  const seen: (string | number)[][] = [];
  formatJson(withArrayPath, (path, lexeme) => {
    seen.push([...path]);
    return lexeme;
  });
  expect(seen).toEqual([
    ["rows", 0, "value"],
    ["rows", 1, "value"],
    ["outside"],
  ]);
});

test("large and deep input need not materialize scalar descendants; malformed input never becomes evidence", async () => {
  for (const source of [
    "",
    "{a:1}",
    "[1,]",
    '{"a":1,}',
    "truex",
    "01",
    "1e+",
    "1.",
    '"a\n"',
    '"\\u000G"',
  ]) {
    await expect(readJsonDocument(source, signal())).rejects.toThrow();
    expect(() => formatJson(source)).toThrow();
  }
  const source =
    "[" +
    "0,".repeat(30000) +
    "[".repeat(12000) +
    "false" +
    "]".repeat(12000) +
    "]";
  const document = await readJsonDocument(source, signal());
  expect(document.root.count).toBe(30001);
  const [last] = await readChildren(
    document,
    document.root,
    30_000,
    30_001,
    signal(),
  );
  expect(last.count).toBe(1);
  expect((await copyJsonNode(document, last, signal())).length).toBe(24_005);
  const hugeString = '"' + "😀".repeat(1_000_000) + '"';
  const iterator = scanJson(hugeString);
  expect(iterator.next().value).toMatchObject({
    kind: "checkpoint",
    start: 8192,
  });
  const controller = new AbortController();
  const pending = readJsonDocument(hugeString.repeat(5), controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(stringWindow('"\\uD83D\\uDE00\n"', 1, 13, 1)).toEqual({
    text: "😀",
    end: 13,
  });
});

test("structured copies preserve provided values and local diagnostics never read a getter", async () => {
  const shared = { x: -0 };
  const value = { shared, other: shared, text: "a\nb", nested: [true, null] };
  const raw = await readerText({ kind: "value", value }, signal());
  const document = await readJsonDocument(raw, signal(), true);
  expect(await copyJsonNode(document, document.root, signal())).toBe(
    JSON.stringify(value, null, 2).replaceAll('"x": 0', '"x": -0'),
  );
  let accessorReads = 0;
  const fixture = {
    shared,
    other: shared,
    undef: undefined,
    bigint: 42n,
    symbol: Symbol("demo"),
    date: new Date(0),
    expression: /x/gi,
    fn: () => "no",
    unsupported: new Map(),
    get getter() {
      accessorReads++;
      throw Error("not read");
    },
    toJSON() {
      throw Error("not called");
    },
    cycle: null as unknown,
  };
  fixture.cycle = fixture;
  const diagnostic = describeLocalJs(fixture);
  const facts = Object.fromEntries(
    diagnostic.entries!.map((entry) => [entry.key, entry.value().text]),
  );
  expect(facts).toMatchObject({
    shared: "[Object]",
    other: "[Object]",
    undef: "[undefined]",
    bigint: "42n",
    symbol: "Symbol(demo)",
    date: "[Date 1970-01-01T00:00:00.000Z]",
    expression: "[RegExp /x/gi]",
    fn: "[Function]",
    unsupported: "[Unsupported object]",
    getter: "[Accessor not read]",
    toJSON: "[Function]",
    cycle: "[Ancestor cycle]",
  });
  expect(() => [...structuredJson(fixture)]).toThrow();
  expect(accessorReads).toBe(0);
});
