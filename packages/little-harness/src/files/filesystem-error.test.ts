import { describe, expect, it } from "vitest";
import { filesystemError } from "./filesystem-error.js";

describe("filesystemError", () => {
  it.each(["ENOENT", "E2BIG", "EIO_2"])("adds %s to the same mutable error and preserves its message", code => {
    const error = new Error(`${code}: original detail`);
    expect(filesystemError(error)).toBe(error);
    expect(error).toMatchObject({ code, message: `${code}: original detail` });
  });

  it("can fill an explicitly undefined code", () => {
    const error = Object.assign(new Error("ENOENT: absent"), { code: undefined });
    expect(filesystemError(error)).toBe(error);
    expect(error.code).toBe("ENOENT");
  });

  it.each(["EACCES", "", null, 0])("leaves an existing defined code %j untouched", code => {
    const error = Object.assign(new Error("ENOENT: misleading prefix"), { code });
    expect(filesystemError(error)).toBe(error);
    expect(error.code).toBe(code);
  });

  it.each(["plain failure", "detail ENOENT: absent", "enoent: absent", "ENOENT absent"])(
    "leaves an error without the anchored errno prefix untouched: %s", message => {
      const error = new Error(message);
      expect(filesystemError(error)).toBe(error);
      expect(error).not.toHaveProperty("code");
    },
  );

  it.each([undefined, null, "ENOENT: text", { message: "ENOENT: plain object" }])(
    "leaves a non-Error value untouched: %j", error => {
      expect(filesystemError(error)).toBe(error);
    },
  );

  it("preserves a frozen error as the cause of a replacement with the same message and code", () => {
    const original = Object.freeze(new Error("EROFS: frozen storage error"));
    const result = filesystemError(original);
    expect(result).not.toBe(original);
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({ message: original.message, code: "EROFS", cause: original });
    expect(original).not.toHaveProperty("code");
  });
});
