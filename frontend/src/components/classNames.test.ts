// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classNames } from "./classNames";

describe("classNames", () => {
  it("une las clases con un espacio", () => {
    expect(classNames("panel", "roomy")).toBe("panel roomy");
  });

  it("descarta lo que no es una clase", () => {
    expect(classNames("panel", false, undefined, null, "", "extra")).toBe("panel extra");
  });

  it("sin clases devuelve una cadena vacia", () => {
    expect(classNames()).toBe("");
    expect(classNames(undefined, false)).toBe("");
  });
});
