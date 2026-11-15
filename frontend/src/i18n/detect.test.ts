// @vitest-environment node
import { describe, expect, it } from "vitest";
import { detectLanguage } from "./detect";
import { isLanguage, matchLanguage } from "./languages";

describe("detectLanguage", () => {
  it("usa espanol si nada pide otro idioma", () => {
    expect(detectLanguage("", [])).toBe("es");
  });

  it("el parametro lang de la URL manda sobre el navegador", () => {
    expect(detectLanguage("?lang=en", ["es-AR", "es"])).toBe("en");
    expect(detectLanguage("?ra=10&dec=20&lang=es", ["en-US"])).toBe("es");
  });

  it("sin lang usa el primer idioma admitido del navegador", () => {
    expect(detectLanguage("", ["en-US", "es"])).toBe("en");
    expect(detectLanguage("", ["es-AR", "en"])).toBe("es");
    expect(detectLanguage("?ra=10&dec=20", ["fr-FR", "en-GB", "es"])).toBe("en");
  });

  it("cae en espanol si el navegador no pide ninguno admitido", () => {
    expect(detectLanguage("", ["pt-BR", "fr"])).toBe("es");
  });

  it("ignora un lang que no esta admitido y sigue con el navegador", () => {
    expect(detectLanguage("?lang=fr", ["en-US"])).toBe("en");
    expect(detectLanguage("?lang=", ["en-US"])).toBe("en");
    expect(detectLanguage("?lang=xx", [])).toBe("es");
  });

  it("acepta mayusculas y etiquetas con region en lang", () => {
    expect(detectLanguage("?lang=EN", [])).toBe("en");
    expect(detectLanguage("?lang=en-US", [])).toBe("en");
  });
});

describe("matchLanguage", () => {
  it("se queda con la parte principal de la etiqueta", () => {
    expect(matchLanguage("es-419")).toBe("es");
    expect(matchLanguage("en_GB")).toBe("en");
    expect(matchLanguage(" ES ")).toBe("es");
  });

  it("devuelve null si no hay idioma admitido", () => {
    expect(matchLanguage("pt")).toBeNull();
    expect(matchLanguage("")).toBeNull();
    expect(matchLanguage(null)).toBeNull();
    expect(matchLanguage(undefined)).toBeNull();
    // "english" no es una etiqueta: no debe confundirse con "en".
    expect(matchLanguage("english")).toBeNull();
  });
});

describe("isLanguage", () => {
  it("solo acepta los codigos exactos", () => {
    expect(isLanguage("es")).toBe(true);
    expect(isLanguage("en")).toBe(true);
    expect(isLanguage("EN")).toBe(false);
    expect(isLanguage("en-US")).toBe(false);
    expect(isLanguage(3)).toBe(false);
  });
});
