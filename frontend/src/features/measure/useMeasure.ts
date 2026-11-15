// Estado del medidor de movimiento propio.
//
// Lo unico que se guarda son los clics: en que epoca y banda, y sobre que
// pixel. Las marcas (la posicion ajustada, su error) se calculan a partir de
// los clics y de los planos que tiene el store del campo, asi que se rehacen
// solas cuando un plano cambia de revision (de provisorio a definitivo) o
// cuando llega su capa de cobertura.
//
// Una fuente saturada se mide con la capa de cobertura de su plano
// (wingsFit.ts), que el store baja aparte. El primer clic sobre una estrella
// saturada llega antes que la capa: si asi y todo el ajuste da una posicion,
// la marca queda como provisoria y mejora sola; si no la da, el clic queda en
// espera y se vuelve a medir cuando la capa llega.
//
// Uso, en la pantalla que tenga el visor:
//
//   const measure = useMeasure(controller.view.current);
//   <ImageViewer ...>{(overlay) => <MeasureLayer overlay={overlay} measure={measure} />}</ImageViewer>
//   <MeasurePanel measure={measure} />

import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Epoch, Grid, TrackResponse } from "@/api/types";
import type { LoadedPlane } from "@/data/fieldState";
import { planeKey } from "@/data/planeKey";
import { useFieldStore } from "@/state/fieldStore";
import type { ViewerOverlay } from "@/viewer/ImageViewer";
import type { PixelPoint } from "./centroid";
import { type Mark, type MarkResult, measureMark } from "./marks";
import { type CatalogComparison, compareWithTrack, fitMotion, type MotionFit } from "./motion";
import type { SnapFailure } from "./snap";

/** Un clic de la persona: la epoca y la banda que estaba mirando, y el pixel. */
export interface MeasureClick {
  readonly epoch: number;
  readonly detector: number;
  readonly point: PixelPoint;
}

/** Por que el ultimo clic no dejo una marca. */
export type MeasureFailure = SnapFailure | "no-image";

export interface Measure {
  /** Si un clic sobre la imagen deja una marca. */
  readonly active: boolean;
  setActive(active: boolean): void;
  /** Epoca que se marca con un clic: la que esta en pantalla. null si no hay. */
  readonly epoch: number | null;
  /** Fecha de inicio de esa epoca (AAAA-MM-DD), o null. */
  readonly epochDate: string | null;
  /** Hay imagen de esa epoca en la banda actual: se puede marcar. */
  readonly canMark: boolean;
  /** Cantidad de epocas del campo. */
  readonly epochCount: number;
  /** Marcas vigentes, en orden temporal. */
  readonly marks: readonly Mark[];
  /** El ultimo clic no encontro una fuente; null si dejo marca o si todavia se esta midiendo. */
  readonly failure: MeasureFailure | null;
  /** El ultimo clic cayo en una fuente saturada y espera la capa de cobertura para medirla. */
  readonly measuring: boolean;
  /** Ajuste del movimiento propio; null con menos de dos marcas o si son de la misma fecha. */
  readonly fit: MotionFit | null;
  /** Comparacion con la trayectoria de catalogo del objeto buscado, si la hay. */
  readonly comparison: CatalogComparison | null;
  /** Nombre de catalogo del objeto buscado; null si no hay trayectoria. */
  readonly catalogName: string | null;
  /** Grilla del campo, para pasar de cielo a pixel al dibujar. */
  readonly grid: Grid | null;
  /** Marca la epoca en pantalla a partir de un punto de la imagen. */
  pick(point: PixelPoint): void;
  /** Marca la epoca en pantalla en el centro de lo que se ve (para quien no usa el puntero). */
  pickAtViewCenter(): void;
  /** Borra todas las marcas. */
  clear(): void;
  /** La capa deja aca la transformacion vigente del visor; la lee `pickAtViewCenter`. */
  readonly overlayRef: RefObject<ViewerOverlay | null>;
}

const NO_CLICKS: Readonly<Record<number, MeasureClick>> = {};
const NO_MARKS: readonly Mark[] = [];

/** Fecha del plano: la media de sus exposiciones o, si falta, la de la epoca. */
function planeMjd(loaded: LoadedPlane, epochs: readonly Epoch[] | undefined): number | null {
  if (loaded.plane.mjd_mean !== null) return loaded.plane.mjd_mean;
  return epochs?.find((item) => item.epoch === loaded.epoch)?.mjd_mean ?? null;
}

interface MeasureInputs {
  readonly grid: Grid | undefined;
  readonly epochs: readonly Epoch[] | undefined;
  readonly planes: Readonly<Record<string, LoadedPlane>>;
  /** Capa de cobertura de un plano, si es la de la revision bajada. */
  coverageOf(key: string, rev: number): Uint16Array | null;
  /** La capa de ese plano no esta y todavia puede llegar: no se pidio, o esta en camino. */
  coveragePending(key: string, rev: number): boolean;
}

function measureClick(click: MeasureClick, inputs: MeasureInputs): MarkResult | "no-image" {
  const key = planeKey(click.epoch, click.detector);
  const loaded = inputs.planes[key];
  if (inputs.grid === undefined || loaded === undefined) return "no-image";
  const mjd = planeMjd(loaded, inputs.epochs);
  if (mjd === null) return "no-image";
  return measureMark({
    image: loaded.image,
    grid: inputs.grid,
    epoch: click.epoch,
    detector: click.detector,
    rev: loaded.rev,
    mjd,
    click: click.point,
    coverage: inputs.coverageOf(key, loaded.rev),
  });
}

/** Que paso con un clic que no dejo marca: por que fallo, o si espera la capa de cobertura. */
function attemptOutcome(
  click: MeasureClick,
  inputs: MeasureInputs,
): { status: "ok" } | { status: "waiting" } | { status: "failed"; reason: MeasureFailure } {
  const result = measureClick(click, inputs);
  if (result === "no-image") return { status: "failed", reason: "no-image" };
  if (result.ok) return { status: "ok" };
  // Las alas no alcanzaron, pero fue sin la capa de cobertura: con ella puede salir.
  const key = planeKey(click.epoch, click.detector);
  const rev = inputs.planes[key]?.rev;
  if (result.reason === "no-fit" && rev !== undefined && inputs.coveragePending(key, rev)) {
    return { status: "waiting" };
  }
  return { status: "failed", reason: result.reason };
}

/**
 * Medidor de movimiento propio sobre el campo abierto.
 *
 * @param currentEpoch epoca que se ve en pantalla (`ViewModel.current`): la que marca un clic
 */
export function useMeasure(currentEpoch: number | null): Measure {
  const fieldId = useFieldStore((state) => state.fieldId);
  const band = useFieldStore((state) => state.band);
  const grid = useFieldStore((state) => state.meta?.grid);
  const epochs = useFieldStore((state) => state.meta?.epochs);
  const planes = useFieldStore((state) => state.planes);
  const aux = useFieldStore((state) => state.aux);
  const loadAux = useFieldStore((state) => state.loadAux);
  const track: TrackResponse | null = useFieldStore((state) => state.target.track);

  const [active, setActive] = useState(false);
  /** Clics que dejaron marca, por epoca. */
  const [clicks, setClicks] = useState(NO_CLICKS);
  /** El ultimo clic, si no dejo marca: se vuelve a medir cuando cambian los datos. */
  const [attempt, setAttempt] = useState<MeasureClick | null>(null);
  const overlayRef = useRef<ViewerOverlay | null>(null);

  // Otro campo: las marcas del anterior no valen.
  const [seenField, setSeenField] = useState(fieldId);
  if (seenField !== fieldId) {
    setSeenField(fieldId);
    setClicks(NO_CLICKS);
    setAttempt(null);
  }

  const inputs = useMemo<MeasureInputs>(
    () => ({
      grid,
      epochs,
      planes,
      coverageOf(key, rev) {
        const entry = aux[key];
        return entry?.layers && entry.layersRev === rev ? entry.layers.coverage : null;
      },
      coveragePending(key, rev) {
        const entry = aux[key];
        if (entry === undefined) return true;
        if (entry.layers !== null && entry.layersRev === rev) return false;
        return entry.status !== "error";
      },
    }),
    [grid, epochs, planes, aux],
  );

  const marks = useMemo<readonly Mark[]>(() => {
    const found: Mark[] = [];
    for (const click of Object.values(clicks)) {
      const result = measureClick(click, inputs);
      if (result !== "no-image" && result.ok) found.push(result.mark);
    }
    return found.length === 0 ? NO_MARKS : found.sort((a, b) => a.mjd - b.mjd);
  }, [clicks, inputs]);

  const outcome = useMemo(
    () => (attempt === null ? null : attemptOutcome(attempt, inputs)),
    [attempt, inputs],
  );

  // El clic que estaba en espera ya se pudo medir: pasa a ser la marca de su epoca.
  useEffect(() => {
    if (attempt === null || outcome?.status !== "ok") return;
    setClicks((previous) => ({ ...previous, [attempt.epoch]: attempt }));
    setAttempt(null);
  }, [attempt, outcome]);

  // La capa de cobertura se pide apenas hace falta: para una marca medida sin
  // ella y para un clic en espera. El store no repite un pedido hecho o en
  // camino. Los planos que la necesitan van en un texto ("epoca/banda,..."),
  // asi el pedido sale solo cuando esa lista cambia.
  const wanted = [
    ...marks.filter((mark) => mark.needsCoverage),
    ...(attempt !== null && outcome?.status === "waiting" ? [attempt] : []),
  ]
    .map((item) => `${item.epoch}/${item.detector}`)
    .join(",");
  useEffect(() => {
    if (wanted === "") return;
    for (const item of wanted.split(",")) {
      const [epoch, detector] = item.split("/").map(Number);
      if (epoch !== undefined && detector !== undefined) void loadAux(epoch, detector);
    }
  }, [wanted, loadAux]);

  const fit = useMemo(() => fitMotion(marks), [marks]);
  const positions = track?.positions;
  const comparison = useMemo(
    () =>
      fit === null || positions === undefined || positions.length === 0
        ? null
        : compareWithTrack(marks, fit, positions),
    [marks, fit, positions],
  );

  const canMark =
    currentEpoch !== null &&
    grid !== undefined &&
    planes[planeKey(currentEpoch, band)] !== undefined;

  const pick = useCallback(
    (point: PixelPoint) => {
      if (currentEpoch === null) return;
      const click: MeasureClick = { epoch: currentEpoch, detector: band, point };
      const result = measureClick(click, inputs);
      if (result !== "no-image" && result.ok) {
        // Un clic en una epoca ya marcada reemplaza su marca.
        setClicks((previous) => ({ ...previous, [currentEpoch]: click }));
        setAttempt(null);
      } else {
        // No dejo marca: queda como ultimo intento, y la marca anterior de esa epoca no se toca.
        setAttempt(click);
      }
    },
    [currentEpoch, band, inputs],
  );

  const pickAtViewCenter = useCallback(() => {
    const overlay = overlayRef.current;
    if (overlay === null) return;
    pick({ x: overlay.view.centerX, y: overlay.view.centerY });
  }, [pick]);

  const clear = useCallback(() => {
    setClicks(NO_CLICKS);
    setAttempt(null);
  }, []);

  return {
    active,
    setActive,
    epoch: currentEpoch,
    epochDate: epochs?.find((item) => item.epoch === currentEpoch)?.start ?? null,
    canMark,
    epochCount: epochs?.length ?? 0,
    marks,
    failure: outcome?.status === "failed" ? outcome.reason : null,
    measuring: outcome?.status === "waiting",
    fit,
    comparison,
    catalogName: positions !== undefined && positions.length > 0 ? (track?.name ?? null) : null,
    grid: grid ?? null,
    pick,
    pickAtViewCenter,
    clear,
    overlayRef,
  };
}
