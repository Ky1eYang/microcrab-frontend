import { expect, test } from "@playwright/test";
import {
  decodeFrame,
  encodeCommand,
  MAX_FRAME_BYTES,
} from "../src/client/socket/codec";

test("both socket owners share bounded object framing and reject non-envelope JSON", () => {
  for (const value of ["null", "[]", "1", '"text"', "{bad"])
    expect(decodeFrame(value)).toMatchObject({
      ok: false,
      closeCode: 4002,
      reason: expect.any(String),
    });
  expect(decodeFrame(new Uint8Array([1]))).toMatchObject({
    ok: false,
    closeCode: 4009,
  });
  const malformed = decodeFrame("secret-frame-body token=secret-token");
  expect(JSON.stringify(malformed)).not.toContain("secret-frame-body");
  expect(JSON.stringify(malformed)).not.toContain("secret-token");
  // Character count fits, but encoded UTF-8 bytes exceed the wire budget.
  const oversized = JSON.stringify({ text: "é".repeat(MAX_FRAME_BYTES / 2) });
  expect(oversized.length).toBeLessThan(MAX_FRAME_BYTES);
  expect(decodeFrame(oversized)).toMatchObject({
    ok: false,
    closeCode: 4009,
    reason: expect.any(String),
  });
});

test("command framing carries correlation and payload without a second Session authority", () => {
  const operation_id = "operation";
  const decoded = decodeFrame(
    encodeCommand("turn.submit", { operation_id }, "request"),
  );
  expect(decoded).toEqual({
    ok: true,
    frame: {
      v: 1,
      type: "command",
      request_id: "request",
      method: "turn.submit",
      params: { operation_id },
    },
  });
});
