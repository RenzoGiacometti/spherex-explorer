// @vitest-environment node
//
// Textos de la esfera (sphere.es.json, sphere.en.json): los dos idiomas tienen
// las mismas claves y las mismas variables. Es lo que src/i18n/resources.test.ts
// comprueba para los namespaces registrados en resources.ts.

import { describe, expect, it } from "vitest";
import en from "./sphere.en.json";
import es from "./sphere.es.json";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "string") entries.set(path, value);
    else for (const [inner, text] of flatten(value, path)) entries.set(inner, text);
  }
  return entries;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^},\s]+)[^}]*\}\}/g)].map((match) => match[1] ?? "").sort();
}

describe("textos de la esfera", () => {
  const spanish = flatten(es);
  const english = flatten(en);

  it("tienen las mismas claves en espanol y en ingles", () => {
    expect([...english.keys()].sort()).toEqual([...spanish.keys()].sort());
  });

  it("no tienen textos vacios y usan las mismas variables", () => {
    for (const [key, text] of spanish) {
      const other = english.get(key) ?? "";
      expect(text.trim(), key).not.toBe("");
      expect(other.trim(), key).not.toBe("");
      expect(placeholders(other), key).toEqual(placeholders(text));
    }
  });
});
