// Estirado de brillo: de un valor del plano (MJy/sr) a un nivel entre 0 y 1.
//
// Son funciones puras, sin WebGL. El shader de webglRenderer.ts hace la misma
// cuenta con las mismas constantes; compose.ts es la referencia en CPU.
//
// docs/contrato-cubo.md, seccion 5: cada detector trae una escala comun a
// todas sus epocas, `vmin = median - 2 sigma` y `vmax = max(p99,7; median +
// 10 sigma)`, y "el control de contraste se mueve entre esos dos valores".

/** Estirados disponibles en la Etapa 1. */
export const STRETCH_KINDS = ["linear", "log", "asinh"] as const;

export type StretchKind = (typeof STRETCH_KINDS)[number];

/**
 * Estirado de partida. Con asinh se ven a la vez el fondo y las estrellas
 * brillantes; el lineal, con los cortes del detector, deja casi todo en negro.
 */
export const DEFAULT_STRETCH: StretchKind = "asinh";

/** Cortes del estirado: `low` va a negro y `high` a blanco. */
export interface Cuts {
  readonly low: number;
  readonly high: number;
}

/**
 * Parametro del estirado logaritmico, y = ln(1 + a x) / ln(1 + a).
 * 1000 es el valor por defecto de `astropy.visualization.LogStretch` y de DS9.
 */
export const LOG_STRETCH_A = 1000;

/**
 * Parametro del estirado asinh, y = asinh(x / a) / asinh(1 / a).
 * 0,1 es el valor por defecto de `astropy.visualization.AsinhStretch`: por
 * debajo de un decimo del rango la respuesta es casi lineal y por encima,
 * logaritmica.
 */
export const ASINH_STRETCH_A = 0.1;

/**
 * Ancho minimo entre cortes. Evita dividir por cero si llegan dos cortes
 * iguales (un plano constante). Entra en un Float32, que es lo que usa el shader.
 */
export const MIN_CUT_SPAN = 1e-30;

/** Lleva a [0, 1]. Un valor que no es un numero queda en 0. */
export function clampUnit(value: number): number {
  if (!(value > 0)) return 0;
  return Math.min(value, 1);
}

/** Un ancho llevado al minimo admitido. Lo que no es un numero tambien queda en el minimo. */
function atLeastMinSpan(span: number): number {
  if (!(span > MIN_CUT_SPAN)) return MIN_CUT_SPAN;
  return span;
}

/** Ancho entre cortes, nunca menor que `MIN_CUT_SPAN`. */
export function cutSpan(cuts: Cuts): number {
  return atLeastMinSpan(cuts.high - cuts.low);
}

/** Posicion lineal de un valor entre los cortes, recortada a [0, 1]. */
export function normalize(value: number, cuts: Cuts): number {
  return clampUnit((value - cuts.low) / cutSpan(cuts));
}

/** asinh escrito con logaritmo y raiz, igual que en el shader. */
function asinh(value: number): number {
  return Math.log(value + Math.sqrt(value * value + 1));
}

const LOG_NORM = Math.log(1 + LOG_STRETCH_A);
const ASINH_NORM = asinh(1 / ASINH_STRETCH_A);

/**
 * Curva del estirado sobre una posicion ya normalizada: recibe [0, 1] y
 * devuelve [0, 1], con 0 en 0 y 1 en 1, siempre creciente.
 */
export function stretchUnit(position: number, kind: StretchKind): number {
  switch (kind) {
    case "log":
      return Math.log(1 + LOG_STRETCH_A * position) / LOG_NORM;
    case "asinh":
      return asinh(position / ASINH_STRETCH_A) / ASINH_NORM;
    default:
      return position;
  }
}

/** Nivel de 0 a 1 de un valor del plano: recorte entre los cortes y curva. */
export function stretchValue(value: number, cuts: Cuts, kind: StretchKind): number {
  return stretchUnit(normalize(value, cuts), kind);
}

/**
 * Nivel de 0 a 1 de una diferencia, con escala simetrica: 0 queda en gris
 * medio (0,5), `+halfRange` o mas en blanco y `-halfRange` o menos en negro. La
 * curva se aplica al valor absoluto, asi que las dos mitades son espejo.
 */
export function stretchSigned(delta: number, halfRange: number, kind: StretchKind): number {
  const ratio = delta / atLeastMinSpan(halfRange);
  const magnitude = stretchUnit(clampUnit(Math.abs(ratio)), kind);
  return 0.5 + 0.5 * (ratio < 0 ? -magnitude : magnitude);
}

/**
 * Medio rango de la escala del modo diferencia para unos cortes: el mismo
 * ancho que la imagen sola. Una fuente que aparece en una sola de las dos
 * epocas queda tan clara (o tan oscura) como se ve en el modo de un plano.
 */
export function differenceHalfRange(cuts: Cuts): number {
  return cutSpan(cuts);
}

/** Nivel de 0 a 1 como byte de 0 a 255, redondeando al mas cercano. */
export function toByte(level: number): number {
  return Math.round(clampUnit(level) * 255);
}

// ---- Control de contraste ------------------------------------------------

/** Lo que hace falta de `detectors[].display` o de `preview.display`. */
export interface DisplayRange {
  readonly vmin: number;
  readonly vmax: number;
  /** Ruido robusto del detector. Si falta, el tope del contraste es una fraccion del rango. */
  readonly sigma?: number | undefined;
}

/** Extremos del deslizador de contraste. */
export const MIN_CONTRAST = 0;
export const MAX_CONTRAST = 1;

/**
 * Contraste de partida: la mitad del recorrido. Es el valor con el que se
 * miraron los dos campos de muestra (Barnard y WISE 0855) al armar el visor;
 * con 0 los cortes son los del detector tal cual.
 */
export const DEFAULT_CONTRAST = 0.5;

/**
 * Con el contraste al maximo quedan `MIN_SPAN_SIGMAS` sigma entre los cortes.
 * Como `vmin` es la mediana menos 2 sigma, el corte alto queda en la mediana
 * mas 2 sigma: el ruido del fondo ocupa toda la escala.
 */
export const MIN_SPAN_SIGMAS = 4;

/** Tope del contraste cuando no hay sigma: esta fraccion del rango completo. */
export const MIN_SPAN_FRACTION = 1 / 256;

/**
 * Cortes para una posicion del deslizador de contraste, de 0 a 1.
 *
 * - El corte bajo no se mueve: siempre es `vmin`.
 * - El corte alto baja de `vmax` (contraste 0, la escala completa del
 *   detector) hacia `vmin` (contraste 1), sin llegar: se detiene en
 *   `vmin + 4 sigma`.
 * - El recorrido es geometrico, no lineal: cada paso del deslizador divide el
 *   ancho por el mismo factor. Con un recorrido lineal casi todo el cambio
 *   visible quedaria en el ultimo tramo, porque `vmax` suele estar a cientos
 *   de sigma.
 */
export function contrastCuts(display: DisplayRange, contrast: number): Cuts {
  const low = display.vmin;
  const full = display.vmax - display.vmin;
  if (!(full > 0)) return { low, high: display.vmax };

  const sigma = display.sigma;
  const narrowest =
    sigma !== undefined && sigma > 0
      ? Math.min(full, MIN_SPAN_SIGMAS * sigma)
      : full * MIN_SPAN_FRACTION;
  const position = clampUnit(contrast);
  const span = full * (narrowest / full) ** position;
  return { low, high: low + span };
}
