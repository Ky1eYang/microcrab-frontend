type EventKind =
  | "object"
  | "array"
  | "endObject"
  | "endArray"
  | "key"
  | "string"
  | "number"
  | "literal"
  | "checkpoint";
export type JsonEvent = {
  [K in EventKind]: { kind: K; start: number; end: number };
}[EventKind];

/** Strict JSON grammar shared by formatting and evidence readers. Events carry
 * UTF-16 offsets into the supplied source, not decoded or reserialized values.
 * Checkpoints let cooperative consumers yield even inside a very large token. */
export function* scanJson(
  source: string,
  start = 0,
  end = source.length,
): Generator<JsonEvent> {
  let cursor = start;
  let checkpoint = start + 8192;
  const event = (kind: JsonEvent["kind"], from: number): JsonEvent => ({
    kind,
    start: from,
    end: cursor,
  });
  const step = () => {
    if (cursor < checkpoint) return;
    checkpoint = cursor + 8192;
    return event("checkpoint", cursor);
  };
  const fail = (reason: string): never => {
    throw new Error(`${reason} (${cursor + 1})`);
  };
  function* whitespace() {
    while (cursor < end && " \t\r\n".includes(source[cursor])) {
      cursor++;
      const pause = step();
      if (pause) yield pause;
    }
  }
  function* quoted(kind: "key" | "string"): Generator<JsonEvent> {
    const from = cursor++;
    while (cursor < end) {
      const ch = source[cursor++];
      if (ch === '"') {
        yield event(kind, from);
        return;
      }
      if (ch.charCodeAt(0) < 32)
        fail("Unescaped control character in JSON string");
      if (ch === "\\") {
        const escaped = cursor < end ? source[cursor++] : "";
        if (escaped === "u") {
          if (
            cursor + 4 > end ||
            !/^[0-9a-fA-F]{4}$/.test(source.slice(cursor, cursor + 4))
          )
            fail("Expected four hexadecimal digits after \\u");
          cursor += 4;
        } else if (!escaped || !'"\\/bfnrt'.includes(escaped))
          fail("Invalid JSON escape");
      }
      const pause = step();
      if (pause) yield pause;
    }
    fail("Unterminated JSON string");
  }
  const digit = () =>
    cursor < end && source[cursor] >= "0" && source[cursor] <= "9";
  function* digits() {
    while (digit()) {
      cursor++;
      const pause = step();
      if (pause) yield pause;
    }
  }
  function* scalar(): Generator<JsonEvent> {
    const from = cursor;
    if (source[cursor] === '"') {
      yield* quoted("string");
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (
        cursor + literal.length <= end &&
        source.startsWith(literal, cursor)
      ) {
        cursor += literal.length;
        yield event("literal", from);
        return;
      }
    }
    if (source[cursor] === "-" && cursor < end) cursor++;
    if (!digit()) fail("Expected a JSON value");
    if (source[cursor] === "0") cursor++;
    else yield* digits();
    if (cursor < end && source[cursor] === ".") {
      cursor++;
      if (!digit()) fail("Expected a digit after the decimal point");
      yield* digits();
    }
    if (cursor < end && (source[cursor] === "e" || source[cursor] === "E")) {
      cursor++;
      if (cursor < end && (source[cursor] === "+" || source[cursor] === "-"))
        cursor++;
      if (!digit()) fail("Expected an exponent digit");
      yield* digits();
    }
    yield event("number", from);
  }

  // A stack of delimiters, not a recursive descent call stack or an object AST.
  const stack: ("}" | "]")[] = [];
  let expectValue = true;
  while (true) {
    yield* whitespace();
    if (expectValue) {
      if (cursor >= end) fail("Expected a JSON value");
      const ch = source[cursor];
      if (ch === "{" || ch === "[") {
        const close = ch === "{" ? "}" : "]";
        stack.push(close);
        yield event(ch === "{" ? "object" : "array", cursor++);
        yield* whitespace();
        if (cursor < end && source[cursor] === close) {
          stack.pop();
          yield event(close === "}" ? "endObject" : "endArray", cursor++);
          expectValue = false;
          continue;
        }
        if (close === "}") {
          if (cursor >= end || source[cursor] !== '"')
            fail("Expected a quoted JSON object key");
          yield* quoted("key");
          yield* whitespace();
          if (cursor >= end || source[cursor] !== ":")
            fail("Expected : after JSON object key");
          cursor++;
        }
        continue;
      }
      yield* scalar();
      expectValue = false;
      continue;
    }
    const close = stack.at(-1);
    if (!close) {
      if (cursor !== end) fail("Unexpected text after JSON value");
      return;
    }
    if (cursor < end && source[cursor] === close) {
      stack.pop();
      yield event(close === "}" ? "endObject" : "endArray", cursor++);
      continue;
    }
    if (cursor >= end || source[cursor] !== ",")
      fail(`Expected , or ${close} in JSON`);
    cursor++;
    if (close === "}") {
      yield* whitespace();
      if (cursor >= end || source[cursor] !== '"')
        fail("Expected a quoted JSON object key");
      yield* quoted("key");
      yield* whitespace();
      if (cursor >= end || source[cursor] !== ":")
        fail("Expected : after JSON object key");
      cursor++;
    }
    expectValue = true;
  }
}

export function decodeJsonString(
  source: string,
  start: number,
  end: number,
): string {
  // Only decode a known string token. JSON numbers and documents never go through JSON.parse.
  return JSON.parse(source.slice(start, end)) as string;
}
