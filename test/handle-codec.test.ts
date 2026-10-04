import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeActionContext, encodeActionContext } from "../src/core/context.js";
import { decodeHandle, decodeRuntimeTag, encodeHandle, encodeRuntimeTag, isHandle, type HandleKind } from "../src/core/handles.js";

const runtime = "01234567-89ab-cdef-0123-456789abcdef";

describe("v3 continuation handle codec", () => {
  it("preserves all 128 runtime identity bits in a canonical 22 character tag", () => {
    for (const id of [runtime, "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff", ...Array.from({ length: 20 }, () => randomUUID())]) {
      const tag = encodeRuntimeTag(id);
      expect(tag).toHaveLength(22);
      expect(decodeRuntimeTag(tag)).toBe(id);
    }
    expect(encodeRuntimeTag(runtime)).toBe("ASNFZ4mrze8BI0VniavN7w");
    expect(encodeRuntimeTag("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe("_____________________w");
    for (const invalid of ["runtime", runtime + "x", "0".repeat(32), "gggggggg-0000-0000-0000-000000000000"]) {
      expect(() => encodeRuntimeTag(invalid)).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
    }
  });

  it("rejects noncanonical base64 padding and alternative last-digit encodings", () => {
    const tag = encodeRuntimeTag(runtime);
    for (const invalid of [tag + "=", tag.slice(0, -1), tag + "A", tag.slice(0, -1) + "x", tag.replace("_", "/") + "\n", "!".repeat(22)]) {
      expect(() => decodeRuntimeTag(invalid)).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
    }
  });

  it("keeps stable short contexts and validates canonical positive base36 epochs", () => {
    const first = encodeActionContext(runtime, 1);
    expect(first).toBe("c2.ASNFZ4mrze8BI0VniavN7w.1");
    expect(first).toHaveLength(27);
    expect(encodeActionContext(runtime, 1)).toBe(first);
    for (const epoch of [1, 35, 36, Number.MAX_SAFE_INTEGER]) {
      expect(decodeActionContext(encodeActionContext(runtime, epoch))).toEqual({ runtimeId: runtime, worldEpoch: epoch });
    }
    for (const suffix of ["0", "01", "Z", "-1", "+1", "1.0", "1e+2", (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(36)]) {
      expect(() => decodeActionContext(`c2.${encodeRuntimeTag(runtime)}.${suffix}`)).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
    }
    for (const invalid of [first + "=", " " + first, first + "\n", first.replace("c2", "c1"), "mcctx1.W10", "c2.ASNFZ4mrze8BI0VniavN7x.1"]) {
      expect(() => decodeActionContext(invalid)).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
    }
    for (const epoch of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => encodeActionContext(runtime, epoch)).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
    }
  });

  it("uses typed canonical sequences and rejects wrong types and legacy UUID prefixes", () => {
    for (const kind of ["p", "e", "a", "f", "s", "m"] as HandleKind[]) {
      for (const sequence of [1, 35, 36, Number.MAX_SAFE_INTEGER]) {
        const handle = encodeHandle(runtime, kind, sequence);
        expect(decodeHandle(handle, kind)).toEqual({ runtimeId: runtime, kind, sequence });
        expect(isHandle(handle, kind)).toBe(true);
      }
    }
    expect(decodeHandle(encodeHandle(runtime, "s", 0))).toMatchObject({ sequence: 0 });
    expect(decodeHandle(encodeHandle(runtime, "p", 1), ["p", "e"]).kind).toBe("p");
    for (const invalid of [`${runtime}:a1`, `${encodeRuntimeTag(runtime)}:a0`, `${encodeRuntimeTag(runtime)}:a01`, `${encodeRuntimeTag(runtime)}:aA`, `${encodeRuntimeTag(runtime)}:a${(BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(36)}`]) {
      expect(isHandle(invalid)).toBe(false);
      expect(() => decodeHandle(invalid)).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
    }
    expect(isHandle(encodeHandle(runtime, "s", 1), "a")).toBe(false);
    expect(isHandle(null)).toBe(false);
    expect(() => encodeHandle(runtime, "a", 0)).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
  });
});
