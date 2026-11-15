// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEGREE,
  DOUBLE_PRIME,
  EN_DASH,
  formatArcminutes,
  formatArcseconds,
  formatBand,
  formatDec,
  formatDecimal,
  formatDegrees,
  formatInteger,
  formatIsoDate,
  formatIsoDateTime,
  formatMjdDate,
  formatPercent,
  formatRa,
  formatUtcTime,
  formatWavelength,
  formatWaveRange,
  MICRO,
  MINUS,
  mjdToDate,
  NO_VALUE,
  PRIME,
} from "./format";

describe("caracteres tipograficos", () => {
  it("son los de DESIGN.md y no sus parecidos de teclado", () => {
    expect(MINUS.codePointAt(0)).toBe(0x2212);
    expect(PRIME.codePointAt(0)).toBe(0x2032);
    expect(DOUBLE_PRIME.codePointAt(0)).toBe(0x2033);
    expect(DEGREE.codePointAt(0)).toBe(0x00b0);
    expect(MICRO.codePointAt(0)).toBe(0x00b5);
    expect(EN_DASH.codePointAt(0)).toBe(0x2013);
    expect(NO_VALUE.codePointAt(0)).toBe(0x2014);
  });
});

describe("formatRa", () => {
  it("da el ejemplo de DESIGN.md", () => {
    // 22h 04m 10s = (22 + 4/60 + 10/3600) * 15 grados
    expect(formatRa(331.0416667)).toBe("22h 04m 10s");
  });

  it("formatea las coordenadas de WISE 0855 (08h55m10.831s)", () => {
    const ra = (8 + 55 / 60 + 10.831 / 3600) * 15;
    expect(formatRa(ra)).toBe("08h 55m 11s");
    expect(formatRa(ra, { decimals: 1, language: "es" })).toBe("08h 55m 10,8s");
    expect(formatRa(ra, { decimals: 2, language: "en" })).toBe("08h 55m 10.83s");
  });

  it("rellena con ceros", () => {
    expect(formatRa(0)).toBe("00h 00m 00s");
    expect(formatRa(15.25)).toBe("01h 01m 00s");
  });

  it("acarrea el redondeo en vez de mostrar 60s o 60m", () => {
    // 59,6 s redondea a un minuto entero.
    expect(formatRa((59.6 / 3600) * 15)).toBe("00h 01m 00s");
    expect(formatRa((59 / 60 + 59.6 / 3600) * 15)).toBe("01h 00m 00s");
  });

  it("vuelve a 00h al redondear justo debajo de 360 grados", () => {
    expect(formatRa(359.99999)).toBe("00h 00m 00s");
  });

  it("normaliza valores fuera de [0, 360)", () => {
    expect(formatRa(360 + 15)).toBe("01h 00m 00s");
    expect(formatRa(-15)).toBe("23h 00m 00s");
  });

  it("devuelve una raya si no hay valor", () => {
    expect(formatRa(Number.NaN)).toBe("—");
  });
});

describe("formatDec", () => {
  it("da el ejemplo de DESIGN.md, con menos tipografico y primas reales", () => {
    const dec = -(56 + 46 / 60 + 58 / 3600);
    expect(formatDec(dec)).toBe("−56° 46′ 58″");
  });

  it("no usa el guion ni las comillas del teclado", () => {
    const text = formatDec(-7.2422);
    expect(text).not.toContain("-");
    expect(text).not.toContain("'");
    expect(text).not.toContain('"');
    expect(text).toBe("−07° 14′ 32″");
  });

  it("pone el signo mas en las positivas", () => {
    expect(formatDec(4.7683)).toBe("+04° 46′ 06″");
    expect(formatDec(0)).toBe("+00° 00′ 00″");
  });

  it("no muestra menos cero", () => {
    expect(formatDec(-0.00001)).toBe("+00° 00′ 00″");
  });

  it("acarrea el redondeo", () => {
    expect(formatDec(-(10 + 59 / 60 + 59.7 / 3600))).toBe("−11° 00′ 00″");
  });

  it("admite decimales en los segundos, con la coma o el punto del idioma", () => {
    // WISE 0855: -07d14m42.53s
    const dec = -(7 + 14 / 60 + 42.53 / 3600);
    expect(formatDec(dec, { decimals: 1, language: "es" })).toBe("−07° 14′ 42,5″");
    expect(formatDec(dec, { decimals: 2, language: "en" })).toBe("−07° 14′ 42.53″");
  });

  it("limita a los polos", () => {
    expect(formatDec(90)).toBe("+90° 00′ 00″");
    expect(formatDec(-95)).toBe("−90° 00′ 00″");
  });

  it("devuelve una raya si no hay valor", () => {
    expect(formatDec(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatDecimal", () => {
  it("usa coma en espanol y punto en ingles", () => {
    expect(formatDecimal(0.75, "es")).toBe("0,75");
    expect(formatDecimal(0.75, "en")).toBe("0.75");
  });

  it("respeta la cantidad de decimales", () => {
    expect(formatDecimal(3.075, "es", 3)).toBe("3,075");
    expect(formatDecimal(10.39, "en", 1)).toBe("10.4");
    expect(formatDecimal(155.4, "es", 0)).toBe("155");
  });

  it("no agrupa los miles", () => {
    expect(formatDecimal(60913.7, "es", 1)).toBe("60913,7");
    expect(formatDecimal(60913.7, "en", 1)).toBe("60913.7");
  });

  it("usa el signo menos tipografico", () => {
    expect(formatDecimal(-0.08, "es")).toBe("−0,08");
    expect(formatDecimal(-801.551, "en", 3)).toBe("−801.551");
  });

  it("no muestra menos cero", () => {
    expect(formatDecimal(-0.001, "es")).toBe("0,00");
    expect(formatDecimal(-0, "en", 1)).toBe("0.0");
  });

  it("devuelve una raya para NaN e infinito", () => {
    expect(formatDecimal(Number.NaN, "es")).toBe("—");
    expect(formatDecimal(Number.POSITIVE_INFINITY, "en")).toBe("—");
  });
});

describe("formatInteger", () => {
  it("redondea y no agrupa los miles", () => {
    expect(formatInteger(358)).toBe("358");
    expect(formatInteger(12345.6)).toBe("12346");
  });

  it("usa el signo menos tipografico y evita el menos cero", () => {
    expect(formatInteger(-3)).toBe("−3");
    expect(formatInteger(-0.2)).toBe("0");
  });
});

describe("fechas", () => {
  it("formatea la fecha ISO en UTC", () => {
    expect(formatIsoDate(new Date(Date.UTC(2025, 11, 3, 23, 59)))).toBe("2025-12-03");
    expect(formatIsoDate(new Date("2025-12-03T00:00:00-05:00"))).toBe("2025-12-03");
    expect(formatIsoDate(new Date("2025-12-03T23:00:00-05:00"))).toBe("2025-12-04");
  });

  it("formatea la hora en UTC", () => {
    const date = new Date("2026-11-15T06:21:10Z");
    expect(formatUtcTime(date)).toBe("06:21 UTC");
    expect(formatIsoDateTime(date)).toBe("2026-11-15 06:21 UTC");
  });

  it("convierte MJD a fecha", () => {
    // MJD 40587 es el 1 de enero de 1970; MJD 51544.5 es J2000.0.
    expect(mjdToDate(40587).getTime()).toBe(0);
    expect(mjdToDate(51544.5).toISOString()).toBe("2000-01-01T12:00:00.000Z");
  });

  it("formatea las fechas del contrato", () => {
    // epochs[0] del ejemplo del contrato: mjd_start 60902.86 es 2025-08-15.
    expect(formatMjdDate(60902.86)).toBe("2025-08-15");
    expect(formatMjdDate(60949.31)).toBe("2025-10-01");
  });

  it("devuelve una raya para fechas invalidas", () => {
    expect(formatIsoDate(new Date(Number.NaN))).toBe("—");
    expect(formatUtcTime(new Date(Number.NaN))).toBe("—");
    expect(formatMjdDate(Number.NaN)).toBe("—");
  });
});

describe("longitud de onda", () => {
  it("lleva la unidad con el signo micro", () => {
    expect(formatWavelength(0.75, "es")).toBe("0,75 µm");
    expect(formatWavelength(0.75, "en")).toBe("0.75 µm");
    expect(formatWavelength(3.4, "es", 1)).toBe("3,4 µm");
  });

  it("formatea el rango de una banda como en el selector", () => {
    expect(formatWaveRange(1.63, 2.43, "es")).toBe("1,63–2,43");
    expect(formatWaveRange(4.41, 5.01, "en")).toBe("4.41–5.01");
  });
});

describe("angulos", () => {
  it("formatea grados decimales", () => {
    expect(formatDegrees(133.7598, "es")).toBe("133,7598°");
    expect(formatDegrees(-7.2422, "en")).toBe("−7.2422°");
  });

  it("formatea el lado del campo en minutos de arco", () => {
    expect(formatArcminutes(0.0833, "es")).toBe("5′");
    expect(formatArcminutes(0.1667, "es")).toBe("10′");
    expect(formatArcminutes(0.5, "en")).toBe("30′");
  });

  it("formatea segundos de arco", () => {
    expect(formatArcseconds(3.075, "es", 3)).toBe("3,075″");
    expect(formatArcseconds(14.1, "en")).toBe("14.1″");
  });
});

describe("formatPercent", () => {
  it("lleva espacio en espanol y no en ingles", () => {
    expect(formatPercent(0.64, "es")).toBe("64 %");
    expect(formatPercent(0.64, "en")).toBe("64%");
    expect(formatPercent(0.972, "es", 1)).toBe("97,2 %");
  });
});

describe("formatBand", () => {
  it("muestra el detector como banda", () => {
    expect(formatBand(1)).toBe("B1");
    expect(formatBand(6)).toBe("B6");
  });
});
