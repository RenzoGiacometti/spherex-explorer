import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_URL_STATE,
  hasField,
  normalizeUrlState,
  parseUrlState,
  serializeUrlState,
  type UrlState,
  useUrlState,
} from "./urlState";

// Ejemplo de SPEC.md, seccion 3.3: WISE 0855 en su posicion de 2026.
const SPEC_EXAMPLE = "?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink";

function state(overrides: Partial<UrlState>): UrlState {
  return { ...DEFAULT_URL_STATE, ...overrides };
}

describe("parseUrlState", () => {
  it("sin parametros da los valores por defecto y ningun campo", () => {
    const parsed = parseUrlState("");
    expect(parsed).toEqual({
      ra: null,
      dec: null,
      fov: 0.1667,
      band: 3,
      mode: "blink",
      epoch: null,
      ref: null,
      stretch: null,
      name: null,
      embed: false,
      lang: null,
    });
    expect(hasField(parsed)).toBe(false);
  });

  it("lee el ejemplo de SPEC.md", () => {
    const parsed = parseUrlState(SPEC_EXAMPLE);
    expect(parsed).toEqual(
      state({ ra: 133.7598, dec: -7.2422, fov: 0.1667, band: 6, mode: "blink" }),
    );
    expect(hasField(parsed)).toBe(true);
  });

  it("lee todos los parametros", () => {
    const parsed = parseUrlState(
      "?ra=269.4463&dec=4.7683&fov=0.5&band=1&mode=difference&epoch=2&ref=1&stretch=log&name=Barnard%27s+Star&embed=1&lang=en",
    );
    expect(parsed).toEqual({
      ra: 269.4463,
      dec: 4.7683,
      fov: 0.5,
      band: 1,
      mode: "difference",
      epoch: 2,
      ref: 1,
      stretch: "log",
      name: "Barnard's Star",
      embed: true,
      lang: "en",
    });
  });

  it("acepta la cadena con o sin el signo de pregunta", () => {
    expect(parseUrlState("ra=10&dec=20")).toEqual(parseUrlState("?ra=10&dec=20"));
  });

  describe("coordenadas", () => {
    it("valen solo de a dos", () => {
      expect(hasField(parseUrlState("?ra=10"))).toBe(false);
      expect(hasField(parseUrlState("?dec=10"))).toBe(false);
    });

    it("rechaza lo que no es un numero decimal", () => {
      for (const search of [
        "?ra=abc&dec=10",
        "?ra=&dec=10",
        "?ra=10&dec=",
        "?ra=1e2&dec=10",
        "?ra=0x10&dec=10",
        "?ra=10&dec=NaN",
        "?ra=Infinity&dec=10",
        "?ra=10,5&dec=10",
        "?ra=10%20&dec=10",
      ]) {
        expect(parseUrlState(search).ra, search).toBeNull();
        expect(parseUrlState(search).dec, search).toBeNull();
      }
    });

    it("rechaza una declinacion fuera de -90 a 90", () => {
      expect(hasField(parseUrlState("?ra=10&dec=90.01"))).toBe(false);
      expect(hasField(parseUrlState("?ra=10&dec=-91"))).toBe(false);
      expect(hasField(parseUrlState("?ra=10&dec=90"))).toBe(true);
      expect(hasField(parseUrlState("?ra=10&dec=-90"))).toBe(true);
    });

    it("lleva la ascension recta a [0, 360)", () => {
      expect(parseUrlState("?ra=370&dec=0").ra).toBe(10);
      expect(parseUrlState("?ra=-10&dec=0").ra).toBe(350);
      expect(parseUrlState("?ra=360&dec=0").ra).toBe(0);
      expect(parseUrlState("?ra=359.99999&dec=0").ra).toBe(0);
    });

    it("redondea a 4 decimales, como el backend", () => {
      const parsed = parseUrlState("?ra=269.44630001&dec=4.76834999");
      expect(parsed.ra).toBe(269.4463);
      expect(parsed.dec).toBe(4.7683);
    });

    it("acepta el signo mas y los decimales sin parte entera", () => {
      const parsed = parseUrlState("?ra=%2B10.5&dec=-.5");
      expect(parsed.ra).toBe(10.5);
      expect(parsed.dec).toBe(-0.5);
    });
  });

  describe("fov", () => {
    it("acepta las tres vistas", () => {
      expect(parseUrlState("?fov=0.0833").fov).toBe(0.0833);
      expect(parseUrlState("?fov=0.1667").fov).toBe(0.1667);
      expect(parseUrlState("?fov=0.5").fov).toBe(0.5);
    });

    it("lleva un valor intermedio a la vista que lo contiene", () => {
      expect(parseUrlState("?fov=0.1").fov).toBe(0.1667);
      expect(parseUrlState("?fov=0.3").fov).toBe(0.5);
    });

    it("usa el valor por defecto si es invalido o esta fuera de rango", () => {
      for (const value of ["1", "0", "-0.5", "abc", ""]) {
        expect(parseUrlState(`?fov=${value}`).fov, value).toBe(0.1667);
      }
    });
  });

  describe("band", () => {
    it("acepta de 1 a 6", () => {
      for (const band of [1, 2, 3, 4, 5, 6]) {
        expect(parseUrlState(`?band=${band}`).band).toBe(band);
      }
    });

    it("usa la banda 3 si es invalida", () => {
      for (const value of ["0", "7", "3.5", "-1", "B3", "", "33"]) {
        expect(parseUrlState(`?band=${value}`).band, value).toBe(3);
      }
    });
  });

  describe("mode", () => {
    it("acepta los seis modos", () => {
      for (const mode of ["blink", "difference", "sum", "redcyan", "hold", "journey"]) {
        expect(parseUrlState(`?mode=${mode}`).mode).toBe(mode);
      }
    });

    it("usa blink si es invalido", () => {
      for (const value of ["", "BLINK", "diff", "rgb"]) {
        expect(parseUrlState(`?mode=${value}`).mode, value).toBe("blink");
      }
    });
  });

  describe("epoch", () => {
    it("acepta enteros desde 1", () => {
      expect(parseUrlState("?epoch=1").epoch).toBe(1);
      expect(parseUrlState("?epoch=4").epoch).toBe(4);
    });

    it("queda en null si es invalida", () => {
      for (const value of ["0", "-1", "1.5", "abc", "", "1000"]) {
        expect(parseUrlState(`?epoch=${value}`).epoch, value).toBeNull();
      }
    });
  });

  describe("ref", () => {
    it("acepta enteros desde 1", () => {
      expect(parseUrlState("?ref=1").ref).toBe(1);
      expect(parseUrlState("?ref=3").ref).toBe(3);
    });

    it("queda en null (la elige el visor) si falta o es invalida", () => {
      expect(parseUrlState("").ref).toBeNull();
      for (const value of ["0", "-1", "1.5", "abc", "", "1000"]) {
        expect(parseUrlState(`?ref=${value}`).ref, value).toBeNull();
      }
    });
  });

  describe("stretch", () => {
    it("acepta los tres estirados", () => {
      for (const stretch of ["linear", "log", "asinh"]) {
        expect(parseUrlState(`?stretch=${stretch}`).stretch).toBe(stretch);
      }
    });

    it("queda en null (el del modo) si falta o es invalido", () => {
      expect(parseUrlState("").stretch).toBeNull();
      for (const value of ["", "LINEAR", "sqrt", "1"]) {
        expect(parseUrlState(`?stretch=${value}`).stretch, value).toBeNull();
      }
    });
  });

  describe("name", () => {
    it("recorta los espacios", () => {
      expect(parseUrlState("?name=%20WISE%200855%20").name).toBe("WISE 0855");
    });

    it("queda en null si esta vacio o es demasiado largo", () => {
      expect(parseUrlState("?name=").name).toBeNull();
      expect(parseUrlState("?name=%20%20").name).toBeNull();
      expect(parseUrlState(`?name=${"x".repeat(121)}`).name).toBeNull();
    });
  });

  describe("embed", () => {
    it("se activa con 1 o true", () => {
      expect(parseUrlState("?embed=1").embed).toBe(true);
      expect(parseUrlState("?embed=true").embed).toBe(true);
    });

    it("queda apagado con cualquier otra cosa", () => {
      for (const value of ["0", "false", "", "yes"]) {
        expect(parseUrlState(`?embed=${value}`).embed, value).toBe(false);
      }
    });
  });

  describe("lang", () => {
    it("acepta espanol e ingles, tambien con region", () => {
      expect(parseUrlState("?lang=es").lang).toBe("es");
      expect(parseUrlState("?lang=en").lang).toBe("en");
      expect(parseUrlState("?lang=EN").lang).toBe("en");
      expect(parseUrlState("?lang=es-AR").lang).toBe("es");
    });

    it("queda en null para un idioma que no esta", () => {
      expect(parseUrlState("?lang=fr").lang).toBeNull();
      expect(parseUrlState("?lang=").lang).toBeNull();
    });
  });
});

describe("serializeUrlState", () => {
  it("escribe el ejemplo de SPEC.md tal cual", () => {
    expect(
      serializeUrlState(state({ ra: 133.7598, dec: -7.2422, fov: 0.1667, band: 6, mode: "blink" })),
    ).toBe(SPEC_EXAMPLE);
  });

  it("sin campo no escribe nada", () => {
    expect(serializeUrlState(DEFAULT_URL_STATE)).toBe("");
  });

  it("sin campo conserva solo embed y lang", () => {
    expect(
      serializeUrlState(
        state({
          band: 5,
          mode: "sum",
          epoch: 2,
          ref: 1,
          stretch: "linear",
          name: "x",
          lang: "en",
        }),
      ),
    ).toBe("?lang=en");
    expect(serializeUrlState(state({ embed: true }))).toBe("?embed=1");
  });

  it("escribe los opcionales solo si estan, en orden fijo", () => {
    expect(
      serializeUrlState(
        state({
          ra: 269.4463,
          dec: 4.7683,
          fov: 0.5,
          band: 1,
          mode: "redcyan",
          epoch: 3,
          name: "Barnard's Star",
          embed: true,
          lang: "es",
        }),
      ),
    ).toBe(
      "?ra=269.4463&dec=4.7683&fov=0.5&band=1&mode=redcyan&epoch=3&name=Barnard%27s+Star&embed=1&lang=es",
    );
  });

  it("escribe la referencia y el estirado solo si se eligieron, despues de la epoca", () => {
    const base = state({ ra: 133.7598, dec: -7.2422, band: 6, mode: "difference" });
    expect(serializeUrlState(base)).toBe(
      "?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=difference",
    );
    expect(serializeUrlState({ ...base, epoch: 3, ref: 2, stretch: "asinh", name: "x" })).toBe(
      "?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=difference&epoch=3&ref=2&stretch=asinh&name=x",
    );
    expect(serializeUrlState({ ...base, stretch: "linear" })).toBe(
      "?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=difference&stretch=linear",
    );
  });

  it("redondea las coordenadas a 4 decimales y sin ceros de relleno", () => {
    expect(serializeUrlState(state({ ra: 10.123456, dec: -0.00001 }))).toBe(
      "?ra=10.1235&dec=0&fov=0.1667&band=3&mode=blink",
    );
    expect(serializeUrlState(state({ ra: 359.99999, dec: 45 }))).toBe(
      "?ra=0&dec=45&fov=0.1667&band=3&mode=blink",
    );
  });

  it("ida y vuelta: lo que se escribe se lee igual", () => {
    const original = state({
      ra: 82.1875,
      dec: 30.4012,
      fov: 0.0833,
      band: 2,
      mode: "hold",
      epoch: 2,
      ref: 1,
      stretch: "linear",
      name: "RW Aurigae",
      embed: true,
      lang: "en",
    });
    expect(parseUrlState(serializeUrlState(original))).toEqual(original);
  });
});

describe("normalizeUrlState", () => {
  it("deja el estado como quedaria en la URL", () => {
    expect(normalizeUrlState(state({ ra: 370.123456, dec: 10, name: "  x  " }))).toEqual(
      state({ ra: 10.1235, dec: 10, name: "x" }),
    );
  });

  it("descarta epoch, ref, stretch y name si no hay campo", () => {
    expect(
      normalizeUrlState(state({ epoch: 2, ref: 1, stretch: "log", name: "x", band: 5 })),
    ).toEqual(DEFAULT_URL_STATE);
  });
});

describe("useUrlState", () => {
  function setLocation(search: string): void {
    window.history.replaceState(null, "", `/${search}`);
    useUrlState.getState().syncFromLocation();
  }

  function snapshot(): UrlState {
    const { update: _update, syncFromLocation: _sync, ...rest } = useUrlState.getState();
    return rest;
  }

  beforeEach(() => {
    setLocation("");
  });

  afterEach(() => {
    setLocation("");
  });

  it("lee el estado de la barra de direcciones", () => {
    setLocation(SPEC_EXAMPLE);
    expect(snapshot()).toEqual(
      state({ ra: 133.7598, dec: -7.2422, fov: 0.1667, band: 6, mode: "blink" }),
    );
  });

  it("update escribe en la barra de direcciones", () => {
    setLocation(SPEC_EXAMPLE);
    useUrlState.getState().update({ band: 2, mode: "sum" });
    expect(window.location.search).toBe("?ra=133.7598&dec=-7.2422&fov=0.1667&band=2&mode=sum");
    expect(useUrlState.getState().band).toBe(2);
    expect(useUrlState.getState().mode).toBe("sum");
  });

  it("update reemplaza la entrada del historial por defecto y agrega una con push", () => {
    setLocation(SPEC_EXAMPLE);
    const before = window.history.length;

    useUrlState.getState().update({ band: 1 });
    expect(window.history.length).toBe(before);

    useUrlState.getState().update({ ra: 269.4463, dec: 4.7683 }, { history: "push" });
    expect(window.history.length).toBe(before + 1);
    expect(window.location.search).toBe("?ra=269.4463&dec=4.7683&fov=0.1667&band=1&mode=blink");
  });

  it("update escribe la referencia y el estirado reemplazando la entrada del historial", () => {
    setLocation(`${SPEC_EXAMPLE}&epoch=3`);
    const before = window.history.length;

    useUrlState.getState().update({ ref: 2 });
    useUrlState.getState().update({ stretch: "linear" });

    expect(window.history.length).toBe(before);
    expect(window.location.search).toBe(`${SPEC_EXAMPLE}&epoch=3&ref=2&stretch=linear`);
    // Volver a los valores automaticos los saca de la URL.
    useUrlState.getState().update({ ref: null, stretch: null });
    expect(window.location.search).toBe(`${SPEC_EXAMPLE}&epoch=3`);
  });

  it("otro campo no hereda la epoca de referencia; el estirado si", () => {
    setLocation(`${SPEC_EXAMPLE}&ref=2&stretch=log`);

    useUrlState.getState().update({ band: 5 });
    expect(useUrlState.getState().ref).toBe(2);

    useUrlState.getState().update({ ra: 269.4463, dec: 4.7683 }, { history: "push" });
    expect(useUrlState.getState().ref).toBeNull();
    expect(useUrlState.getState().stretch).toBe("log");
    expect(window.location.search).toBe(
      "?ra=269.4463&dec=4.7683&fov=0.1667&band=5&mode=blink&stretch=log",
    );
    // Salvo que el mismo cambio la traiga (un link armado a mano).
    useUrlState.getState().update({ ra: 133.7598, dec: -7.2422, ref: 1 }, { history: "push" });
    expect(useUrlState.getState().ref).toBe(1);
  });

  it("update normaliza valores invalidos en vez de guardarlos", () => {
    setLocation(SPEC_EXAMPLE);
    useUrlState.getState().update({ ra: 493.75981234, name: "   " });
    expect(useUrlState.getState().ra).toBe(133.7598);
    expect(useUrlState.getState().name).toBeNull();
  });

  it("quitar las coordenadas vuelve a la entrada", () => {
    setLocation(`${SPEC_EXAMPLE}&lang=en`);
    useUrlState.getState().update({ ra: null, dec: null }, { history: "push" });
    expect(window.location.search).toBe("?lang=en");
    expect(hasField(snapshot())).toBe(false);
  });

  it("conserva los parametros que no son suyos y el fragmento", () => {
    window.history.replaceState(null, "", `/${SPEC_EXAMPLE}&utm_source=test#ancla`);
    useUrlState.getState().syncFromLocation();
    useUrlState.getState().update({ band: 4 });
    expect(window.location.search).toBe(
      "?ra=133.7598&dec=-7.2422&fov=0.1667&band=4&mode=blink&utm_source=test",
    );
    expect(window.location.hash).toBe("#ancla");
  });

  it("sigue al historial del navegador (popstate)", () => {
    setLocation(SPEC_EXAMPLE);
    window.history.replaceState(null, "", "/?ra=10&dec=20&band=5");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(snapshot()).toEqual(state({ ra: 10, dec: 20, band: 5 }));
  });
});
