import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ImageTag, QualityNotice } from "@/components";
import a11y from "@/components/a11y.module.css";
import {
  selectBandInfo,
  selectSaturatedRegions,
  selectTargetPosition,
  selectTargetTrail,
} from "@/data/selectors";
import { useLanguage } from "@/i18n/useLanguage";
import {
  formatArcseconds,
  formatBand,
  formatInteger,
  formatWavelength,
  formatWaveRange,
  MICRO,
} from "@/lib/format";
import { useFieldStore } from "@/state/fieldStore";
import { useUrlState } from "@/state/urlState";
import type { ViewerOverlay } from "@/viewer/ImageViewer";
import { imageToScreen } from "@/viewer/view";
import {
  chooseScaleBar,
  formatScaleLabel,
  isInsideRect,
  trailPoints,
  visibleImageRect,
} from "./annotations";
import styles from "./ImageAnnotations.module.css";
import type { ViewerController } from "./useViewerController";

// Punto medio (U+00B7): separa el nombre de la banda de su rango, como en DESIGN.md.
const SEPARATOR = String.fromCodePoint(0x00b7);

/** Separacion entre una anotacion y el borde de la imagen: 16 px, y 12 si la imagen es angosta. */
const INSET = 16;
const INSET_NARROW = 12;
/** Por debajo de este ancho de imagen a la vista, el rotulo de arriba le saca lugar a las esquinas. */
const NARROW_WIDTH = 560;

/** Lado de la rosa N/E y alto del corchete de la barra de escala. */
const COMPASS_SIDE = 56;
const SCALE_TICK = 5;

/** Mira de 64 px (`reticle` de DESIGN.md): circulo de radio 15 y cuatro marcas de 18 a 29. */
const RETICLE_RADIUS = 15;
const RETICLE_TICK_FROM = 18;
const RETICLE_TICK_TO = 29;
/** Donde empieza el nombre, a la derecha (o a la izquierda) del centro de la mira. */
const RETICLE_LABEL_OFFSET = 40;
/** Ancho que se le calcula a cada letra del nombre para saber si entra a la derecha. */
const LABEL_CHAR_WIDTH = 8;

/** Radio de los anillos del rastro (8 px de diametro) y radio minimo de un contorno de saturacion. */
const TRAIL_RADIUS = 4;
const MIN_CONTOUR_RADIUS = 4;
/** Radio minimo, en pantalla, del anillo que marca el punto del espectro. */
const MIN_SPECTRUM_MARK_RADIUS = 7;

/** Alto que ocupa el rotulo de la imagen: la pildora sola, o con su segunda linea. */
const TAG_HEIGHT = 36;
const TAG_HEIGHT_WITH_NOTE = 64;
const TAG_TOP = 8;

export interface ImageAnnotationsProps {
  /** Transformacion vigente del visor: llega de `children` de ImageViewer. */
  readonly overlay: ViewerOverlay;
  readonly controller: ViewerController;
  /**
   * Punto medido para el espectro, en pixeles de imagen, con el radio de la
   * apertura si ya se conoce: el del clic o, si el espectro se ajusto a una
   * fuente guardada del campo, el de esa fuente. null si no hay ninguno o si
   * es el objeto buscado, que ya tiene su mira.
   */
  readonly spectrumMark?: SpectrumMark | null | undefined;
}

export interface SpectrumMark {
  readonly x: number;
  readonly y: number;
  /** Radio de la apertura en pixeles de imagen; null mientras el espectro carga. */
  readonly radiusPx: number | null;
}

/**
 * Lo que se dibuja sobre la imagen (DESIGN.md, "Sobre la imagen"), siguiendo
 * el acercamiento y el desplazamiento:
 *
 * - arriba a la izquierda, el modo y la banda; arriba a la derecha, la rosa N/E;
 * - abajo a la izquierda, la barra de escala con su valor;
 * - arriba al centro, el rotulo de la imagen: plano provisorio con sus
 *   exposiciones, o vista de otro relevamiento;
 * - el contorno de cada region saturada de los planos que se ven y, abajo a la
 *   derecha, el aviso de que hay una fuente saturada;
 * - la mira sobre el objeto buscado en la epoca que se ve, con su nombre y su
 *   movimiento por anio, y el rastro de las epocas anteriores;
 * - un anillo blanco sobre el punto del que se pidio el espectro, del tamano
 *   de la apertura.
 *
 * Los dibujos van en un SVG que los lectores de pantalla saltean; lo que dicen
 * esta, en palabras, en una lista que solo se lee. Mientras no hay ninguna
 * imagen en pantalla no se dibuja nada.
 */
export function ImageAnnotations({ overlay, controller, spectrumMark }: ImageAnnotationsProps) {
  const { t } = useTranslation("viewer");
  const language = useLanguage();
  const { view, source, preview, entries, mode } = controller;
  const { transform, frame, image, viewport } = overlay;
  const composition = source === "spherex" ? view.composition : null;

  // Epoca que se ve: en una comparacion, la actual (A).
  const shownEpoch = !composition
    ? null
    : composition.mode === "single"
      ? (composition.epochs[0] ?? null)
      : view.current;

  const name = useUrlState((state) => state.name);
  const band = useFieldStore((state) => state.band);
  const bandInfo = useFieldStore(selectBandInfo);
  const pixelScale = useFieldStore((state) => state.meta?.grid?.pixel_scale_arcsec);
  const perYear = useFieldStore((state) => state.target.resolved?.motion?.per_year_arcsec ?? null);
  const target = useFieldStore((state) => selectTargetPosition(state, shownEpoch));
  const trail = useFieldStore(selectTargetTrail);
  const epochs = composition?.epochs;
  // Las regiones de cada plano que entra en lo que se ve. Son los objetos del
  // store, sin envolver: la comparacion superficial los reconoce de un dibujo al otro.
  const saturated = useFieldStore(
    useShallow((state) => (epochs ?? []).flatMap((epoch) => selectSaturatedRegions(state, epoch))),
  );
  // Cuantas fuentes hay como mucho en un mismo plano: la misma estrella en tres epocas es una.
  const saturatedSources = useFieldStore((state) =>
    (epochs ?? []).reduce(
      (most, epoch) => Math.max(most, selectSaturatedRegions(state, epoch).length),
      0,
    ),
  );

  const visible = visibleImageRect(transform, image, frame);
  // Sin imagen no hay nada que anotar: una escala suelta sobre el fondo no dice nada.
  if (visible === null || source === "none") return null;

  const inset = visible.width < NARROW_WIDTH ? INSET_NARROW : INSET;
  const left = visible.left + inset;
  const right = visible.left + visible.width - inset;
  const top = visible.top + inset;
  const bottom = visible.top + visible.height - inset;

  // ---- Rotulo de la imagen --------------------------------------------------

  let tag = null;
  let tagHeight = 0;
  if (preview !== null) {
    tagHeight = TAG_HEIGHT_WITH_NOTE;
    tag = (
      <ImageTag
        label={t("stage.preview")}
        value={`${preview.survey} ${formatWavelength(preview.waveUm, language, 1)}`}
        note={t("stage.previewNote")}
      />
    );
  } else if (composition?.mode === "single") {
    const loaded = entries.find((entry) => entry.epoch.epoch === shownEpoch)?.loaded;
    if (loaded?.status === "building") {
      tagHeight = TAG_HEIGHT;
      tag = (
        <ImageTag
          label={t("stage.provisional")}
          value={t("stage.exposures", {
            used: formatInteger(loaded.plane.n_used),
            total: formatInteger(loaded.plane.n_exposures),
          })}
        />
      );
    }
  }
  // En una imagen angosta el rotulo llega a las esquinas: lo de arriba baja.
  const cornerTop = visible.width < NARROW_WIDTH && tag !== null ? top + tagHeight : top;

  // ---- Modo y banda ---------------------------------------------------------

  const modeText = t(`mode.${mode}`);
  const bandText = bandInfo
    ? `${formatBand(band)} ${SEPARATOR} ${formatWaveRange(bandInfo.waveMinUm, bandInfo.waveMaxUm, language)} ${MICRO}m`
    : formatBand(band);

  // ---- Escala ---------------------------------------------------------------

  const scaleBar =
    pixelScale === undefined ? null : chooseScaleBar(pixelScale, transform.scale, visible.width);
  const scaleText = scaleBar === null ? null : formatScaleLabel(scaleBar.arcsec, language);

  // ---- Objeto buscado -------------------------------------------------------

  const reticle =
    composition && target?.inField ? imageToScreen(transform, target.x, target.y) : null;
  const reticleShown = reticle !== null && isInsideRect(frame, reticle.x, reticle.y);
  const motionText =
    perYear === null
      ? null
      : t("annotations.motion", { value: formatArcseconds(perYear, language, 2) });
  // El nombre va a la derecha de la mira, salvo que ahi no entre.
  const labelWidth =
    Math.max(name?.length ?? 0, motionText?.length ?? 0) * LABEL_CHAR_WIDTH + RETICLE_LABEL_OFFSET;
  const labelOnLeft =
    reticle !== null &&
    reticle.x + labelWidth > frame.left + frame.width &&
    reticle.x - labelWidth >= frame.left;
  const rings = composition ? trailPoints(trail, shownEpoch) : [];

  const saturatedText =
    saturatedSources === 0
      ? null
      : saturatedSources === 1
        ? t("annotations.saturated.one")
        : t("annotations.saturated.other", { n: formatInteger(saturatedSources) });

  return (
    <>
      <svg
        className={styles.layer}
        width={viewport.width}
        height={viewport.height}
        aria-hidden="true"
        focusable="false"
      >
        {/* Contornos de saturacion: 1 px claro sobre 3 px de vacio, para que se lean sobre la estrella. */}
        {saturated.map((region, index) => {
          const center = imageToScreen(transform, region.x, region.y);
          const radius = Math.max(MIN_CONTOUR_RADIUS, region.radius_px * transform.scale);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: dos epocas pueden tener la misma region; el orden no cambia
            <g key={index} data-annotation="saturated">
              <circle className={styles.halo} cx={center.x} cy={center.y} r={radius} />
              <circle className={styles.line} cx={center.x} cy={center.y} r={radius} />
            </g>
          );
        })}

        {/* Rastro: anillos de 8 px, mas tenues cuanto mas vieja la epoca. */}
        {rings.map((ring) => {
          const center = imageToScreen(transform, ring.x, ring.y);
          return (
            <g
              key={ring.epoch}
              data-annotation="trail"
              data-epoch={ring.epoch}
              opacity={ring.opacity}
            >
              <circle className={styles.halo} cx={center.x} cy={center.y} r={TRAIL_RADIUS} />
              <circle className={styles.line} cx={center.x} cy={center.y} r={TRAIL_RADIUS} />
            </g>
          );
        })}

        {/* Punto del espectro: un anillo blanco con la apertura con la que se mide. */}
        {spectrumMark === null || spectrumMark === undefined
          ? null
          : (() => {
              const center = imageToScreen(transform, spectrumMark.x, spectrumMark.y);
              const radius = Math.max(
                MIN_SPECTRUM_MARK_RADIUS,
                (spectrumMark.radiusPx ?? 0) * transform.scale,
              );
              return (
                <g data-annotation="spectrum-point">
                  <circle className={styles.halo} cx={center.x} cy={center.y} r={radius} />
                  <circle className={styles.line} cx={center.x} cy={center.y} r={radius} />
                </g>
              );
            })()}

        {/* Mira: uno de los cuatro usos del acento. */}
        {reticle !== null && reticleShown ? (
          <g
            data-annotation="reticle"
            data-epoch={shownEpoch ?? undefined}
            transform={`translate(${reticle.x} ${reticle.y})`}
          >
            {[styles.reticleHalo, styles.reticle].map((className) => (
              <g key={className} className={className}>
                <circle cx={0} cy={0} r={RETICLE_RADIUS} />
                <path
                  d={`M0 ${-RETICLE_TICK_TO}V${-RETICLE_TICK_FROM}M0 ${RETICLE_TICK_FROM}V${RETICLE_TICK_TO}M${-RETICLE_TICK_TO} 0H${-RETICLE_TICK_FROM}M${RETICLE_TICK_FROM} 0H${RETICLE_TICK_TO}`}
                />
              </g>
            ))}
            {name === null ? null : (
              <text
                className={styles.labelCap}
                x={labelOnLeft ? -RETICLE_LABEL_OFFSET : RETICLE_LABEL_OFFSET}
                y={motionText === null ? 4 : -3}
                textAnchor={labelOnLeft ? "end" : "start"}
              >
                {name}
              </text>
            )}
            {motionText === null ? null : (
              <text
                className={styles.dataMute}
                x={labelOnLeft ? -RETICLE_LABEL_OFFSET : RETICLE_LABEL_OFFSET}
                y={name === null ? 4 : 12}
                textAnchor={labelOnLeft ? "end" : "start"}
              >
                {motionText}
              </text>
            )}
          </g>
        ) : null}

        {/* Modo y banda, arriba a la izquierda. */}
        {composition ? (
          <g data-annotation="band">
            <text className={styles.labelCap} x={left} y={cornerTop + 10}>
              {modeText}
            </text>
            <text className={styles.dataMute} x={left} y={cornerTop + 26}>
              {bandText}
            </text>
          </g>
        ) : null}

        {/* Rosa N/E, arriba a la derecha. La grilla va con el norte arriba y el este a la izquierda. */}
        <g data-annotation="compass" transform={`translate(${right - COMPASS_SIDE} ${cornerTop})`}>
          {[styles.halo, styles.line].map((className) => (
            <path
              key={className}
              className={className}
              d="M44 44V14M44 44H14M40 19l4-5 4 5M19 40l-5 4 5 4"
            />
          ))}
          <text className={styles.dataText} x={44} y={9} textAnchor="middle">
            {t("annotations.north")}
          </text>
          <text className={styles.dataText} x={6} y={47.5} textAnchor="middle">
            {t("annotations.east")}
          </text>
        </g>

        {/* Barra de escala, abajo a la izquierda: su valor y un corchete del largo que mide. */}
        {scaleBar === null || scaleText === null ? null : (
          <g
            data-annotation="scale"
            data-arcsec={scaleBar.arcsec}
            data-length={scaleBar.lengthPx.toFixed(2)}
          >
            {[styles.halo, styles.line].map((className) => (
              <path
                key={className}
                className={className}
                d={`M${left} ${bottom - SCALE_TICK}V${bottom}H${left + scaleBar.lengthPx}V${bottom - SCALE_TICK}`}
              />
            ))}
            <text className={styles.dataText} x={left} y={bottom - SCALE_TICK - 6}>
              {scaleText}
            </text>
          </g>
        )}
      </svg>

      {tag === null ? null : (
        <div
          className={styles.tag}
          data-annotation="tag"
          style={{
            left: visible.left + visible.width / 2,
            top: visible.top + TAG_TOP,
            maxWidth: Math.max(0, visible.width - 2 * TAG_TOP),
          }}
        >
          {tag}
        </div>
      )}

      {saturatedText === null ? null : (
        <div
          className={styles.saturated}
          data-annotation="saturated-notice"
          style={{
            right: viewport.width - right,
            bottom: viewport.height - bottom,
            maxWidth: Math.max(0, visible.width - 2 * inset),
          }}
        >
          <QualityNotice>{saturatedText}</QualityNotice>
        </div>
      )}

      {/* Lo mismo que dicen los dibujos, para quien no los ve. */}
      <ul className={a11y.visuallyHidden} aria-label={t("page.annotationsLabel")}>
        {composition ? (
          <li>{t("annotations.summary.band", { mode: modeText, band: bandText })}</li>
        ) : null}
        {reticleShown && name !== null ? (
          <li>
            {t("annotations.summary.target", { name })}
            {perYear === null
              ? null
              : ` ${t("annotations.summary.motion", { value: formatArcseconds(perYear, language, 2) })}`}
            {rings.length === 0
              ? null
              : ` ${t("annotations.summary.trail", { n: formatInteger(rings.length) })}`}
          </li>
        ) : null}
        {scaleText === null ? null : (
          <li>{t("annotations.summary.scale", { value: scaleText })}</li>
        )}
        <li>{t("annotations.summary.orientation")}</li>
      </ul>
    </>
  );
}
