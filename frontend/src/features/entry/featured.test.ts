// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_URL_STATE, parseUrlState, serializeUrlState } from "@/state/urlState";
import { resolveBarnard } from "@/test/contractExamples";
import metaBarnard from "@/test/fixtures/meta-barnard.json";
import metaEpsIndB from "@/test/fixtures/meta-epsindb.json";
import metaWise0855 from "@/test/fixtures/meta-wise0855.json";
import {
  FEATURED_OBJECTS,
  type FeaturedObject,
  featuredUrlPatch,
  PRECOMPUTED_OBJECTS,
  SEARCH_EXAMPLE,
  savedFieldAt,
  savedFieldByName,
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

describe("savedFieldByName", () => {
  // Lo minimo que tiene que abrir cada campo guardado sin pasar por la red.
  const ALIASES: Record<string, readonly string[]> = {
    barnard: ["Barnard", "Barnards Star", "Barnard's Star", "BARNARD'S STAR", "barnard's-star"],
    "epsilon-indi-b": ["Eps Ind B", "Epsilon Indi B", "eps Indi B"],
    "wise-0855": ["WISE 0855", "W0855", "WISE0855", "wise 0855", "WISE J085510.83-071442.5"],
    "rw-aurigae": ["RW Aur", "RW Aurigae", "rw aur"],
    "r-draconis": ["R Dra", "R Draconis"],
    "proxima-centauri": ["Proxima", "Proxima Cen", "Proxima Centauri", "Próxima Centauri"],
    "luhman-16": ["Luhman 16", "luhman16"],
    "wolf-359": ["Wolf 359", "wolf-359"],
    teegarden: ["Teegarden", "Teegarden's Star", "Teegardens Star"],
    kapteyn: ["Kapteyn", "Kapteyn's Star", "Kapteyns Star"],
    "m-51": ["M51", "M 51", "Messier 51"],
    "m-82": ["M82", "M 82"],
    "m-42": ["M42", "M 42", "Orion Nebula", "Nebulosa de Orion", "Nebulosa de Orión"],
    "m-1": ["M1", "M 1", "Crab Nebula", "Nebulosa del Cangrejo"],
    "m-31": ["M31", "M 31", "Messier 31", "Andromeda Galaxy", "Galaxia de Andrómeda"],
    "m-33": ["M33", "M 33", "Messier 33", "Triangulum Galaxy", "Galaxia del Triángulo"],
    "m-81": ["M81", "M 81", "Messier 81", "Bode's Galaxy", "Galaxia de Bode"],
    "m-101": ["M101", "M 101", "Messier 101", "Pinwheel Galaxy", "Galaxia del Molinete"],
    "m-104": ["M104", "M 104", "Messier 104", "Sombrero Galaxy", "Galaxia del Sombrero"],
  };

  it("cada campo guardado se abre por su nombre y por sus alias", () => {
    expect(Object.keys(ALIASES).sort()).toEqual(PRECOMPUTED_OBJECTS.map((item) => item.id).sort());
    for (const [id, texts] of Object.entries(ALIASES)) {
      for (const text of texts) {
        expect(savedFieldByName(text)?.id, text).toBe(id);
        expect(savedFieldByName(`  ${text.toUpperCase()} `)?.id, text).toBe(id);
      }
    }
  });

  it("un identificador de catalogo sin confirmar no es alias: va al servicio de nombres", () => {
    for (const text of ["GJ 699", "HIP 87937", "NGC 5194", "NGC 1952", "CN Leo", "VZ Pic"]) {
      expect(savedFieldByName(text), text).toBeNull();
    }
    // El que si confirma una respuesta guardada del servicio de nombres.
    expect(savedFieldByName("WISEA J085510.74-071442.5")?.id).toBe("wise-0855");
  });

  it("ningun alias es de dos campos", () => {
    for (const object of PRECOMPUTED_OBJECTS) {
      for (const text of [object.label, object.name, ...object.aliases]) {
        expect(savedFieldByName(text), text).toBe(object);
      }
    }
  });

  it("otro nombre, un nombre parecido o unas coordenadas no son un alias", () => {
    for (const text of [
      "",
      "M 87",
      "M 13",
      "M 511",
      "Barnad Star",
      "wise 08",
      "R Draconis b",
      "269.4463 +4.7683",
      "08h55m10.831s -07d14m42.53s",
    ]) {
      expect(savedFieldByName(text), text).toBeNull();
    }
  });
});

describe("savedFieldAt", () => {
  const WISE = { ra: 133.7598, dec: -7.2422 };
  /** Mitad del lado de la huella, en grados: 5 minutos de arco. */
  const HALF = 5 / 60;

  it("el centro de cada campo guardado cae en su propia huella", () => {
    for (const object of PRECOMPUTED_OBJECTS) {
      expect(savedFieldAt(object), object.label).toBe(object);
    }
  });

  it("las coordenadas de 2010 de WISE 0855 caen en su campo guardado", () => {
    // "08h55m10.831s -07d14m42.53s": a 126 segundos de arco del centro de 2026.
    const field = savedFieldAt({ ra: 133.795129, dec: -7.245147 });
    expect(field).toMatchObject({
      id: "wise-0855",
      name: "WISE J085510.83-071442.5",
      band: 6,
      ...WISE,
    });
  });

  it("unas coordenadas sexagesimales de Barnard caen en su campo guardado", () => {
    // "17h57m47s +04d46m06s".
    const field = savedFieldAt({ ra: 269.445833, dec: 4.768333 });
    expect(field).toMatchObject({ id: "barnard", name: "Barnard's Star", band: 3 });
  });

  it("la huella es un cuadrado: mide medio lado hacia cada borde, no un radio", () => {
    const edge = HALF - 1e-4;
    // Cerca de una esquina, a mas de 5 minutos de arco del centro, sigue adentro.
    expect(savedFieldAt({ ra: WISE.ra, dec: WISE.dec + edge })?.id).toBe("wise-0855");
    expect(savedFieldAt({ ra: WISE.ra, dec: WISE.dec - edge })?.id).toBe("wise-0855");
    expect(savedFieldAt({ ra: WISE.ra + edge, dec: WISE.dec + edge })?.id).toBe("wise-0855");
    // Apenas pasado el borde, afuera.
    expect(savedFieldAt({ ra: WISE.ra, dec: WISE.dec + HALF + 1e-4 })).toBeNull();
    expect(savedFieldAt({ ra: WISE.ra, dec: WISE.dec - HALF - 1e-4 })).toBeNull();
  });

  it("la diferencia en ascension recta se mide sobre el cielo: por el coseno de la declinacion", () => {
    // R Draconis, a 66,8 grados de declinacion: 5 minutos de arco son 0,211 grados de RA.
    const rDra = { ra: 248.1672, dec: 66.755 };
    const halfInRa = HALF / Math.cos((rDra.dec * Math.PI) / 180);
    expect(halfInRa).toBeCloseTo(0.2111, 3);
    expect(savedFieldAt({ ra: rDra.ra + halfInRa - 1e-3, dec: rDra.dec })?.id).toBe("r-draconis");
    expect(savedFieldAt({ ra: rDra.ra - halfInRa + 1e-3, dec: rDra.dec })?.id).toBe("r-draconis");
    expect(savedFieldAt({ ra: rDra.ra + halfInRa + 1e-3, dec: rDra.dec })).toBeNull();
    // Cerca del ecuador la misma diferencia de RA queda afuera.
    expect(savedFieldAt({ ra: WISE.ra + 0.2, dec: WISE.dec })).toBeNull();
  });

  it("cruza la ascension recta 0/360 por el camino corto", () => {
    const base = PRECOMPUTED_OBJECTS[0] as FeaturedObject;
    const east: FeaturedObject = { ...base, id: "borde-este", ra: 359.98, dec: 10 };
    const west: FeaturedObject = { ...base, id: "borde-oeste", ra: 0.01, dec: -30 };
    const fields = [east, west];

    expect(savedFieldAt({ ra: 0.03, dec: 10 }, fields)).toBe(east);
    expect(savedFieldAt({ ra: 359.95, dec: 10.05 }, fields)).toBe(east);
    expect(savedFieldAt({ ra: 359.96, dec: -30 }, fields)).toBe(west);
    expect(savedFieldAt({ ra: 0.05, dec: -30.05 }, fields)).toBe(west);
    // Una vuelta entera de mas o de menos es el mismo punto.
    expect(savedFieldAt({ ra: 360.03, dec: 10 }, fields)).toBe(east);
    expect(savedFieldAt({ ra: -0.04, dec: -30 }, fields)).toBe(west);
    // Del otro lado del cero, pero fuera de la huella.
    expect(savedFieldAt({ ra: 0.2, dec: 10 }, fields)).toBeNull();
    expect(savedFieldAt({ ra: 359.8, dec: -30 }, fields)).toBeNull();
    // A media vuelta no hay nada.
    expect(savedFieldAt({ ra: 180, dec: 10 }, fields)).toBeNull();
  });

  it("si el punto cae en dos huellas gana el centro mas cercano", () => {
    const base = PRECOMPUTED_OBJECTS[0] as FeaturedObject;
    const a: FeaturedObject = { ...base, id: "a", ra: 100, dec: 0 };
    const b: FeaturedObject = { ...base, id: "b", ra: 100.1, dec: 0 };
    expect(savedFieldAt({ ra: 100.04, dec: 0 }, [a, b])).toBe(a);
    expect(savedFieldAt({ ra: 100.06, dec: 0 }, [a, b])).toBe(b);
    expect(savedFieldAt({ ra: 100.06, dec: 0 }, [b, a])).toBe(b);
  });

  it("un punto lejos de todo campo guardado no cae en ninguno", () => {
    // M 87, y un punto a 10 minutos de arco de Barnard.
    expect(savedFieldAt({ ra: 187.7059, dec: 12.3911 })).toBeNull();
    expect(savedFieldAt({ ra: 269.4463, dec: 4.7683 + 10 / 60 })).toBeNull();
  });
});
