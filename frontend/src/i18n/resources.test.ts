// @vitest-environment node
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { currentLanguage, i18n, initI18n, setLanguage } from "./index";
import { SUPPORTED_LANGUAGES } from "./languages";
import { DEFAULT_NAMESPACE, NAMESPACES, resources } from "./resources";

type Tree = { [key: string]: string | Tree };

/** Claves de un arbol de traducciones como rutas con puntos, y sus textos. */
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

function localeFiles(language: string): string[] {
  const directory = fileURLToPath(new URL(`./locales/${language}/`, import.meta.url));
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
}

describe("traducciones", () => {
  it("estan los dos idiomas", () => {
    expect(Object.keys(resources).sort()).toEqual([...SUPPORTED_LANGUAGES].sort());
  });

  it("los dos idiomas tienen los mismos namespaces, y common esta entre ellos", () => {
    expect(Object.keys(resources.en).sort()).toEqual(Object.keys(resources.es).sort());
    expect(NAMESPACES).toContain(DEFAULT_NAMESPACE);
    expect(DEFAULT_NAMESPACE).toBe("common");
  });

  it("cada archivo de locales esta registrado en resources.ts", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      expect(localeFiles(language), language).toEqual(Object.keys(resources[language]).sort());
    }
  });

  for (const namespace of NAMESPACES) {
    describe(`namespace ${namespace}`, () => {
      const es = flatten(resources.es[namespace]);
      const en = flatten(resources.en[namespace]);

      it("tiene las mismas claves en espanol y en ingles", () => {
        expect([...en.keys()].sort()).toEqual([...es.keys()].sort());
      });

      it("no tiene textos vacios", () => {
        for (const [language, entries] of [
          ["es", es],
          ["en", en],
        ] as const) {
          for (const [key, text] of entries) {
            expect(text.trim(), `${language}/${namespace}:${key}`).not.toBe("");
          }
        }
      });

      it("usa las mismas variables de interpolacion en los dos idiomas", () => {
        for (const [key, text] of es) {
          expect(placeholders(en.get(key) ?? ""), `${namespace}:${key}`).toEqual(
            placeholders(text),
          );
        }
      });
    });
  }
});

describe("initI18n", () => {
  afterEach(async () => {
    await setLanguage("es");
  });

  it("arranca en el idioma pedido y traduce de forma sincronica", () => {
    initI18n("es");
    expect(i18n.isInitialized).toBe(true);
    expect(currentLanguage()).toBe("es");
    expect(i18n.t("field.ra", { ns: "viewer" })).toBe("Ascensión recta");
    expect(i18n.t("app.name")).toBe("SkyBlink");
  });

  it("cambia de idioma", async () => {
    initI18n("es");
    await setLanguage("en");
    expect(currentLanguage()).toBe("en");
    expect(i18n.t("field.ra", { ns: "viewer" })).toBe("Right ascension");

    await setLanguage("es");
    expect(i18n.t("mode.hold", { ns: "viewer" })).toBe("Mantener apretado");
  });

  it("llamarlo de nuevo no reinicia nada y aplica el idioma pedido", () => {
    initI18n("es");
    initI18n("en");
    expect(currentLanguage()).toBe("en");
  });
});
