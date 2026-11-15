// @vitest-environment node
//
// El juego de iconos contra DESIGN.md. Va aparte de Icon.test.tsx porque lee
// un archivo del repositorio y eso necesita el entorno de Node.

import { describe, expect, it } from "vitest";
import { readRepoFile } from "@/test/sourceFiles";
import { ICON_NAMES } from "./Icon";

/** Nombres de la lista "Conjunto actual" de DESIGN.md, seccion "Iconos". */
function designIconNames(): string[] {
  const match = /Conjunto actual: ([^.]+)\./.exec(readRepoFile("DESIGN.md"));
  return (match?.[1] ?? "").split(",").map((name) => name.trim());
}

describe("juego de iconos", () => {
  it("es el que nombra DESIGN.md, en el mismo orden", () => {
    const names = designIconNames();

    expect(names).toHaveLength(24);
    expect(ICON_NAMES).toEqual(names);
  });

  it("no repite nombres", () => {
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
  });
});
