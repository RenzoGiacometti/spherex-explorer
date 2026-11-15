// @vitest-environment node
//
// Textos de la galeria (gallery.es.json, gallery.en.json). Van al lado de la
// pagina de desarrollo y no en src/i18n/locales: lo que se importa en
// src/i18n/resources.ts viaja en el sitio compilado, y la galeria no existe ahi.
//
// Este archivo no importa la pagina: al cargarse, la pagina suma sus textos a
// i18next, que los agrega sobre los mismos objetos de resources.ts.

import { describe, expect, it } from "vitest";
import { NAMESPACES, resources } from "@/i18n/resources";
import en from "./gallery.en.json";
import es from "./gallery.es.json";

type Tree = { [key: string]: string | Tree };

/** Claves de un arbol de textos como rutas con puntos, y sus textos. */
function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "string") entries.set(path, value);
    else for (const [inner, text] of flatten(value, path)) entries.set(inner, text);
  }
  return entries;
}

/** Variables de interpolacion de un texto: "{{n}} de {{total}}" da ["n", "total"]. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^},\s]+)[^}]*\}\}/g)].map((match) => match[1] ?? "").sort();
}

describe("textos de la galeria", () => {
  it("no viajan en el sitio compilado: no estan entre los textos de la aplicacion", () => {
    expect(NAMESPACES).not.toContain("gallery");
    for (const [language, texts] of [
      ["es", es],
      ["en", en],
    ] as const) {
      const bundled = JSON.stringify(resources[language]);
      expect(Object.keys(resources[language].components)).not.toContain("gallery");
      expect(bundled).not.toContain(JSON.stringify(texts.title));
      expect(bundled).not.toContain(JSON.stringify(texts.search.hint));
    }
  });

  it("tienen las mismas claves en espanol y en ingles", () => {
    expect([...flatten(en).keys()].sort()).toEqual([...flatten(es).keys()].sort());
  });

  it("no tienen textos vacios", () => {
    for (const [language, texts] of [
      ["es", flatten(es)],
      ["en", flatten(en)],
    ] as const) {
      for (const [key, text] of texts) expect(text.trim(), `${language}:${key}`).not.toBe("");
    }
  });

  it("usan las mismas variables de interpolacion en los dos idiomas", () => {
    const english = flatten(en);
    for (const [key, text] of flatten(es)) {
      expect(placeholders(english.get(key) ?? ""), key).toEqual(placeholders(text));
    }
  });
});
