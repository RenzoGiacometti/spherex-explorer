import { useMemo } from "react";
import { Button, classNames, DataGroup, DataRow, GlassPanel } from "@/components";
import type { Language } from "@/i18n/languages";
import { useLanguage } from "@/i18n/useLanguage";
import { formatArcseconds, formatDecimal, formatInteger, NO_VALUE } from "@/lib/format";
import { type GridWcs, skyToPixel } from "@/lib/wcs";
import { gaiaPositionAt } from "./gaia";
import type { FramePoint } from "./journey";
import styles from "./ObjectCard.module.css";
import objectCardEn from "./objectCard.en.json";
import objectCardEs from "./objectCard.es.json";
import {
  DEFAULT_SEARCH_RADIUS_ARCSEC,
  NEARBY_RADIUS_ARCSEC,
  nearestSource,
  type ObjectFacts,
  objectFacts,
  roundSignificant,
} from "./objectFacts";
import type { GaiaCatalog } from "./schema";
import { registerTexts, type Texts, useTexts } from "./texts";

// Los textos de la ficha van al lado y se registran al cargar este modulo (ver texts.ts).
export const OBJECT_CARD_NAMESPACE = "objectCard";
registerTexts(OBJECT_CARD_NAMESPACE, { es: objectCardEs, en: objectCardEn });

type CardTexts = Texts<typeof objectCardEs>;

// Signo "mayor que" (U+003E), armado por codigo para que no parezca una etiqueta en el JSX.
const GREATER_THAN = String.fromCodePoint(0x003e);

export interface ObjectCardProps {
  /** Fuentes de Gaia del campo, o null si todavia no llegaron. */
  readonly catalog: GaiaCatalog | null;
  /** WCS de la grilla del campo. */
  readonly grid: GridWcs;
  /** Pixel de la grilla donde se hizo clic, o null si todavia no hubo ninguno. */
  readonly point: FramePoint | null;
  /** Fecha de la imagen sobre la que se hizo clic (anio juliano): las fuentes se buscan donde estaban. */
  readonly year: number;
  /** Radio dentro del cual una fuente cuenta como la del clic, en segundos de arco. */
  readonly searchRadiusArcsec?: number;
  /**
   * Si no hay fuente en el punto pero si una cerca, la ficha ofrece verla: llama
   * a esta funcion con el pixel de esa fuente, para que quien la usa mueva ahi el
   * punto elegido. Sin esta funcion solo lo informa.
   */
  readonly onPick?: ((point: FramePoint) => void) | undefined;
  readonly className?: string | undefined;
}

/** Un numero con dos cifras significativas, como se dice en una frase: 5,96 es "6" y 4,25 es "4,2". */
export function formatApproximate(value: number, language: Language): string {
  const rounded = roundSignificant(value, 2);
  return rounded < 10 && !Number.isInteger(rounded)
    ? formatDecimal(rounded, language, 1)
    : formatInteger(rounded);
}

/** Un numero con tres cifras significativas, para la cifra destacada: 5,96; 326; 1300. */
export function formatFigure(value: number, language: Language): string {
  const rounded = roundSignificant(value, 3);
  if (rounded >= 100) return formatInteger(rounded);
  return formatDecimal(rounded, language, rounded >= 10 ? 1 : 2);
}

/** Movimiento propio en segundos de arco por anio, con dos cifras significativas: 10″; 0,0052″. */
export function formatMotionRate(masPerYear: number, language: Language): string {
  const arcsec = roundSignificant(masPerYear / 1000, 2);
  const decimals = arcsec <= 0 ? 0 : Math.min(5, Math.max(0, 1 - Math.floor(Math.log10(arcsec))));
  return formatArcseconds(arcsec, language, decimals);
}

function distanceSentences(facts: ObjectFacts, language: Language, t: CardTexts): string[] {
  const { distance } = facts;
  switch (distance.kind) {
    case "measured":
    case "rough": {
      const lightYears = formatApproximate(distance.lightYears, language);
      return [
        t(`distance.${distance.kind}`, { lightYears }),
        t(`light.${distance.kind}`, { years: lightYears }),
      ];
    }
    case "far": {
      const lightYears = formatApproximate(distance.beyondLightYears, language);
      return [t("distance.far", { lightYears }), t("light.far", { years: lightYears })];
    }
    default:
      return [t("distance.none")];
  }
}

function motionSentences(facts: ObjectFacts, language: Language, t: CardTexts): string[] {
  const { motion } = facts;
  if (motion === null) return [t("motion.none")];
  if (!motion.significant || motion.direction === null || motion.yearsToCrossMoon === null) {
    return [t("motion.still")];
  }
  const sentences = [
    t("motion.moving", {
      rate: formatMotionRate(motion.total, language),
      direction: t(`direction.${motion.direction}`),
      years: formatApproximate(motion.yearsToCrossMoon, language),
    }),
  ];
  if (facts.transverseKmS !== null) {
    sentences.push(
      t("motion.velocity", { speed: formatApproximate(facts.transverseKmS, language) }),
    );
  }
  return sentences;
}

function distanceFigure(facts: ObjectFacts, language: Language): string {
  const { distance } = facts;
  if (distance.kind === "measured" || distance.kind === "rough") {
    return formatFigure(distance.lightYears, language);
  }
  if (distance.kind === "far") {
    return `${GREATER_THAN} ${formatApproximate(distance.beyondLightYears, language)}`;
  }
  return NO_VALUE;
}

/**
 * Ficha del objeto (DESIGN.md, "Espectro": distancia y movimiento propio como
 * celdas con `data-lg` y como `data-row`). Para la fuente de Gaia mas cercana
 * al clic dice, en lenguaje llano, a que distancia esta en anios luz, hace
 * cuanto salio la luz que se ve, cuanto y hacia donde se mueve, y con que se la
 * puede ver. Debajo quedan los valores de catalogo, para copiar.
 *
 * Si no hay ninguna fuente de Gaia cerca del clic, lo dice y explica por que
 * puede pasar: Gaia mide en luz visible y un objeto muy frio, como WISE 0855,
 * se le escapa aunque brille en el infrarrojo.
 *
 * Lo que la ficha afirma depende de cuan bien medida este la paralaje: con una
 * paralaje chica frente a su error tipico solo da un piso para la distancia
 * (objectFacts.ts).
 */
export function ObjectCard({
  catalog,
  grid,
  point,
  year,
  searchRadiusArcsec = DEFAULT_SEARCH_RADIUS_ARCSEC,
  onPick,
  className,
}: ObjectCardProps) {
  const t = useTexts<typeof objectCardEs>(OBJECT_CARD_NAMESPACE);
  const language = useLanguage();

  const found = useMemo(
    () =>
      catalog === null || point === null
        ? null
        : nearestSource(catalog, grid, point.x, point.y, year, searchRadiusArcsec),
    [catalog, grid, point, year, searchRadiusArcsec],
  );
  const facts = useMemo(
    () => (catalog === null || found === null ? null : objectFacts(catalog, found.index)),
    [catalog, found],
  );

  if (catalog === null || point === null) {
    return (
      <GlassPanel title={t("title")} icon="info" className={className}>
        <p className={styles.hint}>{catalog === null ? t("noCatalog") : t("hint")}</p>
      </GlassPanel>
    );
  }

  if (facts === null || found === null) {
    // Nada en el punto. Si hay una fuente a pocos pixeles se avisa: el clic pudo caer en el borde de una estrella.
    const nearby = nearestSource(
      catalog,
      grid,
      point.x,
      point.y,
      year,
      Math.max(NEARBY_RADIUS_ARCSEC, searchRadiusArcsec),
    );
    const nearbyMagnitude = nearby === null ? null : (catalog.g_mag[nearby.index] ?? null);
    const showNearest = (): void => {
      if (nearby === null || onPick === undefined) return;
      const position = gaiaPositionAt(catalog, nearby.index, year);
      const pixel = skyToPixel(grid, position.ra, position.dec);
      if (pixel !== null) onPick(pixel);
    };
    return (
      <GlassPanel title={t("title")} icon="info" className={className}>
        <div className={styles.empty} data-object-card="empty">
          <p className={classNames(styles.emptyTitle, "type-title")}>{t("empty.title")}</p>
          <p className={styles.sentence}>
            {t("empty.radius", { radius: formatArcseconds(searchRadiusArcsec, language, 1) })}
          </p>
          <p className={styles.sentence}>{t("empty.why")}</p>
          <p className={styles.sentence}>{t("empty.other")}</p>
          {nearby === null ? null : (
            <div className={styles.nearby} data-nearby-index={nearby.index}>
              <p className={styles.note}>
                {t("empty.nearby", {
                  distance: formatArcseconds(nearby.separationArcsec, language, 1),
                  magnitude:
                    nearbyMagnitude === null
                      ? NO_VALUE
                      : formatDecimal(nearbyMagnitude, language, 1),
                })}
              </p>
              {onPick === undefined ? null : (
                <Button icon="target" onClick={showNearest}>
                  {t("empty.showNearest")}
                </Button>
              )}
            </div>
          )}
        </div>
      </GlassPanel>
    );
  }

  const sentences = [
    ...distanceSentences(facts, language, t),
    ...motionSentences(facts, language, t),
    ...(facts.visibility === null || facts.gMag === null
      ? []
      : [
          t(`brightness.${facts.visibility}`, {
            magnitude: formatDecimal(facts.gMag, language, 1),
          }),
        ]),
  ];
  const moving = facts.motion?.significant === true;

  return (
    <GlassPanel
      title={t("title")}
      icon="info"
      aside={t("source.offset", {
        distance: formatArcseconds(found.separationArcsec, language, 1),
      })}
      className={className}
    >
      <div className={styles.card} data-object-card="source" data-source-id={facts.sourceId}>
        <p className={styles.source}>
          <span className="type-label-cap">{t("source.name")}</span>
          <span className={classNames(styles.sourceId, "type-data")}>{facts.sourceId}</span>
        </p>

        <div className={styles.cells}>
          <p className={styles.cell}>
            <span className={classNames(styles.cellLabel, "type-label-cap")}>
              {t("cells.distance")}
            </span>
            <span className="type-data-lg">{distanceFigure(facts, language)}</span>
            <span className={classNames(styles.cellUnit, "type-data-sm")}>
              {facts.distance.kind === "none" ? t("cells.unknown") : t("cells.lightYears")}
            </span>
          </p>
          <p className={styles.cell}>
            <span className={classNames(styles.cellLabel, "type-label-cap")}>
              {t("cells.motion")}
            </span>
            <span className="type-data-lg">
              {facts.motion === null ? NO_VALUE : formatMotionRate(facts.motion.total, language)}
            </span>
            <span className={classNames(styles.cellUnit, "type-data-sm")}>
              {facts.motion === null ? t("cells.unknown") : t("cells.perYear")}
            </span>
          </p>
        </div>

        <ul className={styles.sentences} data-moving={moving}>
          {sentences.map((sentence) => (
            <li key={sentence} className={styles.sentence}>
              {sentence}
            </li>
          ))}
        </ul>

        <DataGroup>
          <DataRow
            label={t("rows.parallax")}
            value={
              facts.parallaxMas === null
                ? NO_VALUE
                : t("rows.units.mas", { value: formatDecimal(facts.parallaxMas, language, 3) })
            }
          />
          <DataRow
            label={t("rows.properMotion")}
            value={
              facts.motion === null
                ? NO_VALUE
                : t("rows.units.masPerYear", {
                    east: formatDecimal(facts.motion.east, language, 2),
                    north: formatDecimal(facts.motion.north, language, 2),
                  })
            }
          />
          <DataRow
            label={t("rows.magnitude")}
            value={facts.gMag === null ? NO_VALUE : formatDecimal(facts.gMag, language, 2)}
          />
        </DataGroup>
      </div>
    </GlassPanel>
  );
}
