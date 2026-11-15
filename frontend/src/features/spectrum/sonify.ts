// Sonificacion del espectro con WebAudio.
//
// El espectro se recorre de izquierda a derecha, de la longitud de onda mas
// corta a la mas larga, en unos segundos. En cada instante el flujo decide la
// altura de la nota (mas flujo, mas agudo, sobre dos octavas) y un poco el
// volumen. Donde no hay datos (un detector saturado, un hueco) hay silencio.
//
// `buildSoundPlan` es una funcion pura que arma los pasos; `playSpectrum` los
// programa en un AudioContext y avisa por donde va, para mover el cursor del
// grafico.

import type { SpectrumBin } from "./types";

export interface SoundStep {
  /** Longitud de onda del paso, um. */
  readonly wavelength: number;
  /** Frecuencia en Hz, o null si el paso es silencio. */
  readonly frequency: number | null;
  /** Volumen de 0 a 1 (antes del volumen general). */
  readonly level: number;
}

export interface SoundPlan {
  readonly steps: readonly SoundStep[];
  readonly durationS: number;
  readonly waveMin: number;
  readonly waveMax: number;
}

export const SOUND_DURATION_S = 8;
const STEPS = 96;
/** La nota mas grave (flujo minimo) y cuantas octavas sube hasta el flujo maximo. */
export const BASE_FREQUENCY_HZ = 196;
export const OCTAVES = 2;
/** Entre dos canales separados por mas de esto no se interpola: es un hueco. */
const MAX_GAP_UM = 0.2;
const MASTER_GAIN = 0.18;

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(fraction * (sorted.length - 1))),
  );
  return sorted[index] ?? 0;
}

/** Flujo interpolado en `wavelength`, o null si cae en un hueco o fuera de los datos. */
function fluxAt(bins: readonly SpectrumBin[], wavelength: number): number | null {
  let before: SpectrumBin | null = null;
  let after: SpectrumBin | null = null;
  for (const bin of bins) {
    if (bin.wavelength_um <= wavelength) before = bin;
    else {
      after = bin;
      break;
    }
  }
  if (before !== null && after !== null) {
    const span = after.wavelength_um - before.wavelength_um;
    if (span > MAX_GAP_UM) return null;
    const t = span <= 0 ? 0 : (wavelength - before.wavelength_um) / span;
    return before.flux_mjy * (1 - t) + after.flux_mjy * t;
  }
  const edge = before ?? after;
  if (edge === null || Math.abs(edge.wavelength_um - wavelength) > MAX_GAP_UM / 2) return null;
  return edge.flux_mjy;
}

/**
 * Arma los pasos del sonido para el rango `[waveMin, waveMax]`. Devuelve null
 * si no hay canales con los que sonar.
 */
export function buildSoundPlan(
  binned: readonly SpectrumBin[],
  waveMin: number,
  waveMax: number,
  durationS: number = SOUND_DURATION_S,
): SoundPlan | null {
  const bins = [...binned]
    .filter((bin) => Number.isFinite(bin.flux_mjy) && Number.isFinite(bin.wavelength_um))
    .sort((a, b) => a.wavelength_um - b.wavelength_um);
  if (bins.length === 0 || !(waveMax > waveMin)) return null;

  // Escala robusta: un canal disparado no aplasta al resto.
  const fluxes = bins.map((bin) => bin.flux_mjy).sort((a, b) => a - b);
  const low = Math.min(0, percentile(fluxes, 0.05));
  const high = percentile(fluxes, 0.97);
  const span = high - low;

  const steps: SoundStep[] = [];
  for (let index = 0; index < STEPS; index += 1) {
    const wavelength = waveMin + ((waveMax - waveMin) * (index + 0.5)) / STEPS;
    const flux = fluxAt(bins, wavelength);
    if (flux === null) {
      steps.push({ wavelength, frequency: null, level: 0 });
      continue;
    }
    const value = span > 0 ? Math.min(1, Math.max(0, (flux - low) / span)) : 0.5;
    steps.push({
      wavelength,
      frequency: BASE_FREQUENCY_HZ * 2 ** (OCTAVES * value),
      level: 0.35 + 0.65 * value,
    });
  }
  return { steps, durationS, waveMin, waveMax };
}

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** Dice si este navegador puede reproducir el sonido. */
export function canPlaySound(): boolean {
  return audioContextConstructor() !== null;
}

export interface SoundPlayback {
  /** Corta el sonido. Se puede llamar mas de una vez. */
  stop(): void;
}

export interface PlayOptions {
  /** Longitud de onda por la que va el recorrido, varias veces por segundo. */
  readonly onProgress?: (wavelength: number) => void;
  /** Termino solo o lo cortaron. */
  readonly onEnd?: () => void;
}

/**
 * Reproduce un plan. Hay que llamarla desde un gesto de la persona (un clic):
 * los navegadores no dejan sonar a una pagina que nadie toco. Devuelve null si
 * el navegador no tiene WebAudio.
 */
export function playSpectrum(plan: SoundPlan, options: PlayOptions = {}): SoundPlayback | null {
  const Constructor = audioContextConstructor();
  if (Constructor === null) return null;

  const context = new Constructor();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "triangle";
  oscillator.connect(gain);
  gain.connect(context.destination);

  const start = context.currentTime + 0.05;
  const stepS = plan.durationS / plan.steps.length;
  gain.gain.setValueAtTime(0, context.currentTime);
  let lastFrequency = BASE_FREQUENCY_HZ;
  plan.steps.forEach((step, index) => {
    const at = start + index * stepS;
    if (step.frequency !== null) {
      lastFrequency = step.frequency;
      oscillator.frequency.linearRampToValueAtTime(step.frequency, at);
    } else {
      oscillator.frequency.setValueAtTime(lastFrequency, at);
    }
    // Rampa corta en cada paso: sin ella, entrar y salir de un silencio hace un chasquido.
    gain.gain.linearRampToValueAtTime(step.level * MASTER_GAIN, at + stepS * 0.5);
  });
  const end = start + plan.durationS;
  gain.gain.linearRampToValueAtTime(0, end + 0.05);
  oscillator.start(start);
  oscillator.stop(end + 0.1);

  let finished = false;
  let frame = 0;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (frame !== 0) cancelAnimationFrame(frame);
    try {
      oscillator.stop();
    } catch {
      // Ya estaba detenido.
    }
    void context.close().catch(() => undefined);
    options.onEnd?.();
  };
  oscillator.onended = finish;

  const tick = (): void => {
    if (finished) return;
    const elapsed = context.currentTime - start;
    const fraction = Math.min(1, Math.max(0, elapsed / plan.durationS));
    options.onProgress?.(plan.waveMin + (plan.waveMax - plan.waveMin) * fraction);
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return { stop: finish };
}
