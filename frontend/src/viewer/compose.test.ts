// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FRONTEND_DIR } from "@/test/sourceFiles";
import type { Rgb, Rgba } from "./colors";
import {
  composeScene,
  HATCH_STRIPE_CSS_PX,
  hatchBand,
  hatchStripe,
  type Scene,
  type SceneMode,
  sameScene,
  sceneHatch,
  sceneSize,
} from "./compose";
import { MASK_NO_DATA, MASK_SATURATED, type PlaneImage, toPlaneImage } from "./planeImage";
import { contrastCuts, STRETCH_KINDS, stretchUnit, toByte } from "./stretch";

const NAN = Number.NaN;
const INF = Number.POSITIVE_INFINITY;

/** Un color cualquiera para "sin datos", distinto de todos los grises. */
const EMPTY: Rgb = [0.2, 0.4, 0.6];
const EMPTY_BYTES = [51, 102, 153, 255];
const WHITE = [255, 255, 255, 255];

const CUTS = { low: 0, high: 10 };

/** Plano de una fila con esos valores. */
function row(...values: number[]): PlaneImage {
  return toPlaneImage(new Float32Array(values), [1, values.length]);
}

function scene(mode: SceneMode, planes: PlaneImage[], extra: Partial<Scene> = {}): Scene {
  return { mode, planes, stretch: "linear", cuts: CUTS, noDataColor: EMPTY, ...extra };
}

/** Los cuatro bytes de un pixel de la salida. */
function pixel(output: Uint8ClampedArray, index: number): number[] {
  return Array.from(output.subarray(index * 4, index * 4 + 4));
}

function gray(level: number): number[] {
  const byte = toByte(level);
  return [byte, byte, byte, 255];
}

describe("composeScene: un plano", () => {
  it("dibuja los valores en gris segun los cortes", () => {
    const output = composeScene(scene("single", [row(0, 5, 10, -4, 99)]));
    expect(output).toHaveLength(5 * 4);
    expect(pixel(output, 0)).toEqual(gray(0));
    expect(pixel(output, 1)).toEqual(gray(0.5));
    expect(pixel(output, 2)).toEqual(gray(1));
    // Fuera de los cortes: negro y blanco.
    expect(pixel(output, 3)).toEqual(gray(0));
    expect(pixel(output, 4)).toEqual(gray(1));
  });

  it("aplica el estirado pedido", () => {
    for (const stretch of STRETCH_KINDS) {
      const output = composeScene(scene("single", [row(1, 5)], { stretch }));
      expect(pixel(output, 0), stretch).toEqual(gray(stretchUnit(0.1, stretch)));
      expect(pixel(output, 1), stretch).toEqual(gray(stretchUnit(0.5, stretch)));
    }
  });

  it("sin datos va con el color de vacio y saturado en blanco maximo", () => {
    const output = composeScene(scene("single", [row(5, NAN, INF)]));
    expect(pixel(output, 0)).toEqual(gray(0.5));
    expect(pixel(output, 1)).toEqual(EMPTY_BYTES);
    expect(pixel(output, 2)).toEqual(WHITE);
  });

  it("la opacidad es siempre total", () => {
    const output = composeScene(scene("single", [row(0, NAN, INF, 7)]));
    for (let index = 0; index < 4; index += 1) expect(output[index * 4 + 3]).toBe(255);
  });
});

describe("composeScene: diferencia", () => {
  it("es B menos A con gris medio en cero y escala simetrica", () => {
    const a = row(5, 5, 5, 5, 5);
    const b = row(5, 10, 0, 15, -5);
    const output = composeScene(scene("difference", [a, b]));
    // El medio rango es el ancho entre cortes: 10.
    expect(pixel(output, 0)).toEqual(gray(0.5));
    expect(pixel(output, 1)).toEqual(gray(0.75));
    expect(pixel(output, 2)).toEqual(gray(0.25));
    expect(pixel(output, 3)).toEqual(gray(1));
    expect(pixel(output, 4)).toEqual(gray(0));
  });

  it("el orden importa: A menos B da el negativo", () => {
    const a = row(2);
    const b = row(6);
    expect(pixel(composeScene(scene("difference", [a, b])), 0)).toEqual(gray(0.7));
    expect(pixel(composeScene(scene("difference", [b, a])), 0)).toEqual(gray(0.3));
  });

  it("no depende del corte bajo, solo del ancho", () => {
    const planes = [row(1), row(4)];
    const one = composeScene(scene("difference", planes, { cuts: { low: 0, high: 10 } }));
    const other = composeScene(scene("difference", planes, { cuts: { low: -7, high: 3 } }));
    expect(Array.from(one)).toEqual(Array.from(other));
  });

  it("aplica el estirado a cada lado de cero", () => {
    const output = composeScene(scene("difference", [row(0, 5), row(5, 0)], { stretch: "asinh" }));
    const half = stretchUnit(0.5, "asinh");
    expect(pixel(output, 0)).toEqual(gray(0.5 + 0.5 * half));
    expect(pixel(output, 1)).toEqual(gray(0.5 - 0.5 * half));
  });

  it("enmascara como sin datos lo saturado o sin datos en cualquiera de las dos", () => {
    const a = row(1, INF, 1, NAN, 1, INF);
    const b = row(1, 1, INF, 1, NAN, NAN);
    const output = composeScene(scene("difference", [a, b]));
    expect(pixel(output, 0)).toEqual(gray(0.5));
    for (let index = 1; index < 6; index += 1) {
      expect(pixel(output, index), `pixel ${index}`).toEqual(EMPTY_BYTES);
    }
  });
});

describe("composeScene: suma", () => {
  it("es el promedio de las epocas validas en cada pixel", () => {
    const output = composeScene(
      scene("sum", [row(2, 2, NAN, NAN), row(4, NAN, 6, NAN), row(6, 8, NAN, NAN)]),
    );
    expect(pixel(output, 0)).toEqual(gray(0.4));
    expect(pixel(output, 1)).toEqual(gray(0.5));
    expect(pixel(output, 2)).toEqual(gray(0.6));
    // Ninguna epoca tiene datos.
    expect(pixel(output, 3)).toEqual(EMPTY_BYTES);
  });

  it("admite de 1 a 4 planos", () => {
    const planes = [row(1), row(3), row(5), row(7)];
    expect(pixel(composeScene(scene("sum", planes.slice(0, 1))), 0)).toEqual(gray(0.1));
    expect(pixel(composeScene(scene("sum", planes.slice(0, 2))), 0)).toEqual(gray(0.2));
    expect(pixel(composeScene(scene("sum", planes.slice(0, 3))), 0)).toEqual(gray(0.3));
    expect(pixel(composeScene(scene("sum", planes)), 0)).toEqual(gray(0.4));
  });

  it("alcanza con que este saturado en una epoca para que quede en blanco", () => {
    const output = composeScene(scene("sum", [row(1, INF, NAN), row(1, 1, INF), row(1, 1, 1)]));
    expect(pixel(output, 0)).toEqual(gray(0.1));
    expect(pixel(output, 1)).toEqual(WHITE);
    expect(pixel(output, 2)).toEqual(WHITE);
  });
});

describe("composeScene: rojo/cian", () => {
  it("pone A en rojo y B en verde y azul, con el mismo estirado", () => {
    const output = composeScene(scene("redcyan", [row(10, 0, 5, 2), row(0, 10, 5, 8)]));
    expect(pixel(output, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(output, 1)).toEqual([0, 255, 255, 255]);
    // Donde las dos epocas coinciden queda gris.
    expect(pixel(output, 2)).toEqual(gray(0.5));
    expect(pixel(output, 3)).toEqual([toByte(0.2), toByte(0.8), toByte(0.8), 255]);
  });

  it("aplica el estirado a cada canal", () => {
    const output = composeScene(scene("redcyan", [row(1), row(5)], { stretch: "log" }));
    const red = toByte(stretchUnit(0.1, "log"));
    const cyan = toByte(stretchUnit(0.5, "log"));
    expect(pixel(output, 0)).toEqual([red, cyan, cyan, 255]);
  });

  it("enmascara como sin datos lo saturado o sin datos en cualquiera de las dos", () => {
    const a = row(1, INF, 1, NAN, 1);
    const b = row(1, 1, INF, 1, NAN);
    const output = composeScene(scene("redcyan", [a, b]));
    expect(pixel(output, 0)).toEqual(gray(0.1));
    for (let index = 1; index < 5; index += 1) {
      expect(pixel(output, index), `pixel ${index}`).toEqual(EMPTY_BYTES);
    }
  });
});

describe("composeScene: capa de resaltado", () => {
  const color: Rgba = [1, 0.5, 0, 0.5];

  it("mezcla el color encima de los pixeles marcados", () => {
    const mask = new Uint8Array([0, 1, 255, 0]);
    const output = composeScene(
      scene("single", [row(0, 0, 10, 10)], { highlight: { mask, color } }),
    );
    expect(pixel(output, 0)).toEqual(gray(0));
    expect(pixel(output, 1)).toEqual([toByte(0.5), toByte(0.25), 0, 255]);
    expect(pixel(output, 2)).toEqual([255, toByte(0.75), toByte(0.5), 255]);
    expect(pixel(output, 3)).toEqual(gray(1));
  });

  it("tambien resalta lo que no tiene datos o esta saturado", () => {
    const mask = new Uint8Array([1, 1]);
    const output = composeScene(scene("single", [row(NAN, INF)], { highlight: { mask, color } }));
    expect(pixel(output, 0)).toEqual([toByte(0.6), toByte(0.45), toByte(0.3), 255]);
    expect(pixel(output, 1)).toEqual([255, toByte(0.75), toByte(0.5), 255]);
  });

  it("con opacidad total tapa lo de abajo y con opacidad 0 no cambia nada", () => {
    const mask = new Uint8Array([1]);
    const planes = [row(5)];
    const solid = composeScene(
      scene("single", planes, { highlight: { mask, color: [0, 1, 0, 1] } }),
    );
    expect(pixel(solid, 0)).toEqual([0, 255, 0, 255]);
    const clear = composeScene(
      scene("single", planes, { highlight: { mask, color: [0, 1, 0, 0] } }),
    );
    expect(pixel(clear, 0)).toEqual(gray(0.5));
  });

  it("se aplica en todos los modos", () => {
    const mask = new Uint8Array([1]);
    const highlight = { mask, color: [1, 1, 1, 1] as Rgba };
    expect(pixel(composeScene(scene("difference", [row(1), row(1)], { highlight })), 0)).toEqual(
      WHITE,
    );
    expect(pixel(composeScene(scene("sum", [row(1), row(1)], { highlight })), 0)).toEqual(WHITE);
    expect(pixel(composeScene(scene("redcyan", [row(1), row(1)], { highlight })), 0)).toEqual(
      WHITE,
    );
  });
});

describe("composeScene: orden de las filas", () => {
  // Dos filas: la 0 (sur) vale 0 y la 1 (norte) vale 10.
  const plane = toPlaneImage(new Float32Array([0, 0, 0, 10, 10, 10]), [2, 3]);

  it("por defecto la fila 0 es el sur, como en el plano y en readPixels", () => {
    const output = composeScene(scene("single", [plane]));
    expect(pixel(output, 0)).toEqual(gray(0));
    expect(pixel(output, 3)).toEqual(gray(1));
  });

  it("con north-first el norte va primero, como en ImageData", () => {
    const output = composeScene(scene("single", [plane]), { rowOrder: "north-first" });
    expect(pixel(output, 0)).toEqual(gray(1));
    expect(pixel(output, 3)).toEqual(gray(0));
  });

  it("no invierte las columnas: la columna 0 (este) queda primera", () => {
    const columns = toPlaneImage(new Float32Array([0, 5, 10, 0, 5, 10]), [2, 3]);
    for (const rowOrder of ["south-first", "north-first"] as const) {
      const output = composeScene(scene("single", [columns]), { rowOrder });
      expect(pixel(output, 0)).toEqual(gray(0));
      expect(pixel(output, 1)).toEqual(gray(0.5));
      expect(pixel(output, 2)).toEqual(gray(1));
    }
  });
});

describe("sceneSize", () => {
  it("devuelve el tamano de los planos", () => {
    const plane = toPlaneImage(new Float32Array(6), [2, 3]);
    expect(sceneSize(scene("single", [plane]))).toEqual({ width: 3, height: 2 });
  });

  it("rechaza una cantidad de planos que no es la del modo", () => {
    const plane = row(1);
    const cases: Array<[SceneMode, number]> = [
      ["single", 0],
      ["single", 2],
      ["difference", 1],
      ["difference", 3],
      ["redcyan", 1],
      ["redcyan", 3],
      ["sum", 0],
      ["sum", 5],
    ];
    for (const [mode, count] of cases) {
      const planes = Array.from({ length: count }, () => plane);
      expect(() => sceneSize(scene(mode, planes)), `${mode} con ${count}`).toThrow(RangeError);
      expect(() => composeScene(scene(mode, planes)), `${mode} con ${count}`).toThrow(RangeError);
    }
  });

  it("rechaza planos de distinto tamano", () => {
    expect(() => sceneSize(scene("difference", [row(1, 2), row(1, 2, 3)]))).toThrow(RangeError);
  });

  it("rechaza una mascara de resaltado de otro largo", () => {
    const highlight = { mask: new Uint8Array(3), color: [1, 1, 1, 1] as Rgba };
    expect(() => sceneSize(scene("single", [row(1, 2)], { highlight }))).toThrow(RangeError);
  });
});

describe("sameScene", () => {
  const plane = row(1, 2);
  const base = scene("single", [plane]);

  it("dos escenas con lo mismo son la misma", () => {
    expect(sameScene(base, base)).toBe(true);
    expect(sameScene(base, scene("single", [plane]))).toBe(true);
    expect(sameScene(null, null)).toBe(true);
  });

  it("cualquier cambio la hace distinta", () => {
    const mask = new Uint8Array(2);
    const highlight = { mask, color: [1, 1, 1, 1] as Rgba };
    const others: Scene[] = [
      scene("sum", [plane]),
      scene("single", [row(1, 2)]),
      scene("single", [plane], { stretch: "log" }),
      scene("single", [plane], { cuts: { low: 0, high: 11 } }),
      scene("single", [plane], { cuts: { low: 1, high: 10 } }),
      scene("single", [plane], { noDataColor: [0, 0, 0] }),
      scene("single", [plane], { highlight }),
    ];
    for (const other of others) expect(sameScene(base, other)).toBe(false);
    expect(sameScene(base, null)).toBe(false);
    expect(sameScene(null, base)).toBe(false);
  });

  it("compara el resaltado por mascara y color", () => {
    const mask = new Uint8Array(2);
    const color: Rgba = [1, 1, 1, 0.5];
    const one = scene("single", [plane], { highlight: { mask, color } });
    expect(sameScene(one, scene("single", [plane], { highlight: { mask, color } }))).toBe(true);
    expect(
      sameScene(one, scene("single", [plane], { highlight: { mask, color: [1, 1, 1, 1] } })),
    ).toBe(false);
    expect(
      sameScene(one, scene("single", [plane], { highlight: { mask: new Uint8Array(2), color } })),
    ).toBe(false);
    expect(sameScene(one, scene("single", [plane], { highlight: null }))).toBe(false);
  });

  it("compara tambien el segundo color de la trama", () => {
    const mask = new Uint8Array(2);
    const color: Rgba = [1, 1, 1, 1];
    const hatched = scene("single", [plane], { highlight: { mask, color, alternate: [0, 0, 0] } });
    expect(
      sameScene(
        hatched,
        scene("single", [plane], { highlight: { mask, color, alternate: [0, 0, 0] } }),
      ),
    ).toBe(true);
    // Con trama y sin trama no dibujan lo mismo, aunque la mascara y el color coincidan.
    expect(sameScene(hatched, scene("single", [plane], { highlight: { mask, color } }))).toBe(
      false,
    );
    expect(
      sameScene(scene("single", [plane], { highlight: { mask, color, alternate: null } }), hatched),
    ).toBe(false);
    expect(
      sameScene(
        hatched,
        scene("single", [plane], { highlight: { mask, color, alternate: [0, 0, 0.5] } }),
      ),
    ).toBe(false);
    // Sin `alternate` y con `alternate` en null es lo mismo.
    expect(
      sameScene(
        scene("single", [plane], { highlight: { mask, color } }),
        scene("single", [plane], { highlight: { mask, color, alternate: null } }),
      ),
    ).toBe(true);
  });
});

describe("trama del resaltado", () => {
  const mask = new Uint8Array([1, 0]);
  const plane = row(5, 5);

  it("mide 1 px CSS: en una pantalla comun, un pixel fisico por franja", () => {
    // DESIGN.md, "Capa de flags": trama diagonal de 1px.
    expect(HATCH_STRIPE_CSS_PX).toBe(1);
    expect(hatchStripe(1)).toBe(1);
    expect(hatchStripe(2)).toBe(2);
    expect(hatchStripe(3)).toBe(3);
    // Densidades con fraccion: la franja es un numero entero de pixeles fisicos.
    expect(hatchStripe(1.25)).toBe(1);
    expect(hatchStripe(1.5)).toBe(2);
    expect(hatchStripe(2.625)).toBe(3);
  });

  it("nunca mide menos de un pixel fisico", () => {
    for (const ratio of [0.5, 0.2, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(hatchStripe(ratio), String(ratio)).toBe(1);
    }
  });

  it("alterna los dos colores en diagonales que suben hacia la derecha", () => {
    // Con franjas de 1: un damero, que es lo que da una diagonal de 1 px.
    expect([0, 1, 2, 3].map((x) => hatchBand(x, 0, 1))).toEqual([0, 1, 0, 1]);
    expect([0, 1, 2, 3].map((x) => hatchBand(x, 1, 1))).toEqual([1, 0, 1, 0]);
    // Un paso a la derecha y uno hacia arriba (la y de pantalla baja) queda en la misma franja.
    for (const stripe of [1, 2, 3]) {
      for (let x = 0; x < 12; x += 1) {
        for (let y = 1; y < 12; y += 1) {
          expect(hatchBand(x + 1, y - 1, stripe)).toBe(hatchBand(x, y, stripe));
        }
      }
    }
    // Con franjas de 2: dos pixeles de cada color a lo largo de una fila.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((x) => hatchBand(x, 0, 2))).toEqual([
      0, 0, 1, 1, 0, 0, 1, 1,
    ]);
  });

  it("se repite cada dos franjas en los dos ejes: sirve como baldosa", () => {
    for (const stripe of [1, 2, 3]) {
      const period = 2 * stripe;
      for (let x = 0; x < period; x += 1) {
        for (let y = 0; y < period; y += 1) {
          expect(hatchBand(x + period, y, stripe)).toBe(hatchBand(x, y, stripe));
          expect(hatchBand(x, y + period, stripe)).toBe(hatchBand(x, y, stripe));
        }
      }
    }
  });

  it("un pixel de imagen de 2 px fisicos o mas siempre muestra los dos colores", () => {
    // Por eso la trama va en pixeles de pantalla: un pixel marcado suelto se
    // distingue sobre cielo oscuro y sobre una estrella.
    for (const side of [2, 3, 4, 7]) {
      for (let left = 0; left < 4; left += 1) {
        for (let top = 0; top < 4; top += 1) {
          const bands = new Set<number>();
          for (let x = left; x < left + side; x += 1) {
            for (let y = top; y < top + side; y += 1) bands.add(hatchBand(x, y, 1));
          }
          expect(bands.size, `lado ${side} en (${left}, ${top})`).toBe(2);
        }
      }
    }
  });

  it("sceneHatch la reconoce por el segundo color", () => {
    const hatch = { mask, color: [1, 1, 1, 1] as Rgba, alternate: [0, 0, 0] as Rgb };
    expect(sceneHatch(scene("single", [plane], { highlight: hatch }))).toBe(hatch);
    expect(sceneHatch(scene("single", [plane]))).toBeNull();
    expect(sceneHatch(scene("single", [plane], { highlight: null }))).toBeNull();
    expect(
      sceneHatch(scene("single", [plane], { highlight: { mask, color: [1, 1, 1, 1] } })),
    ).toBeNull();
    expect(
      sceneHatch(
        scene("single", [plane], { highlight: { mask, color: [1, 1, 1, 1], alternate: null } }),
      ),
    ).toBeNull();
    // Transparente: no hay resaltado, tampoco trama.
    expect(
      sceneHatch(scene("single", [plane], { highlight: { ...hatch, color: [1, 1, 1, 0] } })),
    ).toBeNull();
  });

  it("no entra en la composicion de referencia: va en pixeles de pantalla", () => {
    const hatch = { mask, color: [1, 1, 1, 1] as Rgba, alternate: [0, 0, 0] as Rgb };
    for (const mode of ["single", "sum"] as const) {
      const planes = mode === "single" ? [plane] : [plane, plane];
      expect(Array.from(composeScene(scene(mode, planes, { highlight: hatch })))).toEqual(
        Array.from(composeScene(scene(mode, planes))),
      );
    }
    // El mismo resaltado, liso, si se compone.
    const flat = composeScene(
      scene("single", [plane], { highlight: { mask, color: hatch.color } }),
    );
    expect(pixel(flat, 0)).toEqual(WHITE);
    expect(pixel(flat, 1)).toEqual(gray(0.5));
  });

  it("la mascara tiene que tener el tamano de la imagen, igual que la del resaltado liso", () => {
    const short = { mask: new Uint8Array(1), color: [1, 1, 1, 1] as Rgba, alternate: EMPTY };
    expect(() => sceneSize(scene("single", [plane], { highlight: short }))).toThrow(RangeError);
  });
});

describe("composeScene con el plano de muestra de Barnard", () => {
  // Epoca 1, detector 3: 195 x 195, con 24524 NaN y 152 pixeles saturados
  // (src/test/fixtures/barnard, generado por el backend).
  const file = readFileSync(
    join(FRONTEND_DIR, "src", "test", "fixtures", "barnard", "plane_e1_d3.f32"),
  );
  const source = new Float32Array(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
  );
  const barnard = toPlaneImage(source, [195, 195]);
  const cuts = contrastCuts({ vmin: -0.231633, vmax: 12.3752, sigma: 0.12053 }, 0.5);

  function count(output: Uint8ClampedArray, bytes: number[], where: (index: number) => boolean) {
    let total = 0;
    for (let index = 0; index < barnard.mask.length; index += 1) {
      if (!where(index)) continue;
      if (pixel(output, index).every((byte, channel) => byte === bytes[channel])) total += 1;
    }
    return total;
  }

  const isSaturated = (index: number) => barnard.mask[index] === MASK_SATURATED;
  const isNoData = (index: number) => barnard.mask[index] === MASK_NO_DATA;

  it("trae el nucleo saturado y zonas sin datos", () => {
    expect(barnard.saturatedCount).toBe(152);
    expect(barnard.mask.filter((value) => value === MASK_NO_DATA)).toHaveLength(24524);
  });

  it("en un plano y en suma el nucleo sale blanco y lo que no tiene datos, vacio", () => {
    for (const mode of ["single", "sum"] as const) {
      const output = composeScene({
        mode,
        planes: [barnard],
        stretch: "asinh",
        cuts,
        noDataColor: EMPTY,
      });
      expect(count(output, WHITE, isSaturated), mode).toBe(152);
      expect(count(output, EMPTY_BYTES, isNoData), mode).toBe(24524);
    }
  });

  it("en diferencia y rojo/cian el nucleo queda enmascarado", () => {
    // La segunda epoca es el mismo plano sin el nucleo saturado: vale 1 ahi.
    const filled = toPlaneImage(
      source.map((value) => (value === INF ? 1 : value)),
      [195, 195],
    );
    for (const mode of ["difference", "redcyan"] as const) {
      for (const planes of [
        [barnard, filled],
        [filled, barnard],
      ]) {
        const output = composeScene({ mode, planes, stretch: "asinh", cuts, noDataColor: EMPTY });
        expect(count(output, EMPTY_BYTES, isSaturated), mode).toBe(152);
        expect(count(output, EMPTY_BYTES, isNoData), mode).toBe(24524);
        expect(count(output, WHITE, isSaturated), mode).toBe(0);
      }
    }
  });
});
