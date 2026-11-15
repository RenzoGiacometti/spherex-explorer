// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_URL_STATE, parseUrlState, serializeUrlState } from "@/state/urlState";
import { resolveBarnard } from "@/test/contractExamples";
import metaBarnard from "@/test/fixtures/meta-barnard.json";
import metaEpsIndB from "@/test/fixtures/meta-epsindb.json";
import metaWise0855 from "@/test/fixtures/meta-wise0855.json";
import {
  FEATURED_OBJECTS,
  featuredUrlPatch,
  resolvableName,
  SEARCH_EXAMPLE,
  viewerHref,
} from "./featured";

function featured(id: string) {
  const object = FEATURED_OBJECTS.find((item) => item.id === id);
  if (!object) throw new Error(`no hay un destacado con id ${id}`);
  return object;
}

describe("objetos destacados", () => {
  it("son los cinco objetos de prueba, con el nombre escrito como en el catalogo", () => {
    expect(FEATURED_OBJECTS.map((object) => object.label)).toEqual([
      "Barnard's Star",
      "Epsilon Indi B",
      "WISE 0855",
      "RW Aurigae",
      "R Draconis",
    ]);
    expect(new Set(FEATURED_OBJECTS.map((object) => object.id)).size).toBe(5);
  });

  it("cada uno lleva su link completo al visor", () => {
    const hrefs = FEATURED_OBJECTS.map((object) =>
      viewerHref({ ...DEFAULT_URL_STATE, ...featuredUrlPatch(object) }),
    );
    expect(hrefs).toEqual([
      "/?ra=269.4463&dec=4.7683&fov=0.1667&band=3&mode=blink&name=Barnard%27s+Star",
      "/?ra=331.0966&dec=-56.8006&fov=0.1667&band=3&mode=blink&name=Epsilon+Indi+B",
      "/?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink&name=WISE+J085510.83-071442.5",
      "/?ra=76.9566&dec=30.4013&fov=0.1667&band=1&mode=blink&name=RW+Aurigae",
      "/?ra=248.1672&dec=66.755&fov=0.1667&band=3&mode=blink&name=R+Draconis",
    ]);
  });

  it("el link se lee de vuelta como el mismo estado: nada se pierde ni se corrige", () => {
    for (const object of FEATURED_OBJECTS) {
      const state = { ...DEFAULT_URL_STATE, ...featuredUrlPatch(object) };
      expect(parseUrlState(serializeUrlState(state)), object.label).toEqual(state);
    }
  });

  it("los centros tienen 4 decimales, como los normaliza el backend", () => {
    for (const object of FEATURED_OBJECTS) {
      expect(Number(object.ra.toFixed(4)), object.label).toBe(object.ra);
      expect(Number(object.dec.toFixed(4)), object.label).toBe(object.dec);
      expect(object.ra).toBeGreaterThanOrEqual(0);
      expect(object.ra).toBeLessThan(360);
      expect(Math.abs(object.dec)).toBeLessThanOrEqual(90);
    }
  });

  it("los centros son los de los campos de muestra del backend", () => {
    // `request` de cada muestra es el centro propagado a 2026,0 con el que se armo el campo.
    for (const [id, meta] of [
      ["barnard", metaBarnard],
      ["epsilon-indi-b", metaEpsIndB],
      ["wise-0855", metaWise0855],
    ] as const) {
      const object = featured(id);
      expect({ ra: object.ra, dec: object.dec }, id).toEqual({
        ra: meta.request.ra,
        dec: meta.request.dec,
      });
    }
  });

  it("Barnard va en la posicion propagada del contrato, no en la de catalogo", () => {
    const example = resolveBarnard() as {
      field_center: { ra: number; dec: number };
      j2000: { ra: number; dec: number };
    };
    const barnard = featured("barnard");
    expect({ ra: barnard.ra, dec: barnard.dec }).toEqual({
      ra: example.field_center.ra,
      dec: example.field_center.dec,
    });
    // La de catalogo queda a 4,5 minutos de arco: mas que media vista.
    expect(Math.abs(barnard.dec - example.j2000.dec) * 60).toBeGreaterThan(4);
  });

  it("la banda inicial es la que deja ver cada objeto", () => {
    expect(Object.fromEntries(FEATURED_OBJECTS.map((object) => [object.id, object.band]))).toEqual({
      barnard: 3,
      "epsilon-indi-b": 3,
      // Solo se detecta en los detectores 5 y 6.
      "wise-0855": 6,
      // El unico detector donde no satura.
      "rw-aurigae": 1,
      "r-draconis": 3,
    });
  });

  it("abren en la vista de 10 minutos, en parpadeo y sin epoca fijada", () => {
    for (const object of FEATURED_OBJECTS) {
      expect(featuredUrlPatch(object)).toMatchObject({ fov: 0.1667, mode: "blink", epoch: null });
    }
  });

  it("el ejemplo del buscador es uno de los destacados", () => {
    expect(FEATURED_OBJECTS).toContain(SEARCH_EXAMPLE);
  });
});

describe("resolvableName", () => {
  it("deja pasar un texto cualquiera tal como esta", () => {
    for (const text of ["Barnard's Star", "RW Aurigae", "M 31", "269.4463 4.7683", "wise 08"]) {
      expect(resolvableName(text)).toBe(text);
    }
  });

  it("cambia el apodo de un destacado por el nombre que conoce el catalogo", () => {
    for (const text of ["WISE 0855", "wise 0855", "  Wise   0855 "]) {
      expect(resolvableName(text), text).toBe("WISE J085510.83-071442.5");
    }
  });
});
