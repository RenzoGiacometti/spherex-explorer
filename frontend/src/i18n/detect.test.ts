// @vitest-environment node
import { describe, expect, it } from "vitest";
import { detectLanguage } from "./detect";
import { isLanguage, matchLanguage } from "./languages";

describe("detectLanguage", () => {
  it("usa ingles si la URL no pide otro idioma", () => {
    expect(detectLanguage("")).toBe("en");
    expect(detectLanguage("?ra=10&dec=20")).toBe("en");
  });

  it("el parametro lang de la URL manda", () => {
    expect(detectLanguage("?lang=es")).toBe("es");
    expect(detectLanguage("?lang=en")).toBe("en");
    expect(detectLanguage("?ra=10&dec=20&lang=es")).toBe("es");
  });

  it("ignora un lang que no esta admitido y cae en ingles", () => {
    expect(detectLanguage("?lang=fr")).toBe("en");
    expect(detectLanguage("?lang=")).toBe("en");
    expect(detectLanguage("?lang=xx")).toBe("en");
  });

  it("acepta mayusculas y etiquetas con region en lang", () => {
    expect(detectLanguage("?lang=ES")).toBe("es");
    expect(detectLanguage("?lang=es-AR")).toBe("es");
    expect(detectLanguage("?lang=en-US")).toBe("en");
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
