// Galeria de componentes: /?dev=gallery con `pnpm dev`.
//
// Muestra las primitivas de src/components en todos sus estados, dentro de
// paneles de vidrio y sobre un recorte real de SPHEREx, como van a quedar en el
// visor y en la entrada. El idioma se cambia con el selector de arriba o con
// `&lang=es` y `&lang=en`.
//
// Los datos de muestra son reales: rangos de banda, fechas de epoca y centros
// de campo salen de los campos de muestra de src/test/fixtures.
//
// Los textos de la pagina estan al lado, en gallery.es.json y gallery.en.json,
// y se registran al cargar este modulo. No van en src/i18n/resources.ts: lo
// que se importa ahi viaja en el sitio compilado, y esta pagina no existe en el.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DevPage } from "@/dev/devPages";
import { registerDevTexts } from "@/dev/devTexts";
import type { Language } from "@/i18n/languages";
import { useLanguage } from "@/i18n/useLanguage";
import {
  formatArcminutes,
  formatArcseconds,
  formatBand,
  formatDec,
  formatDecimal,
  formatInteger,
  formatIsoDateTime,
  formatMjdDate,
  formatPercent,
  formatRa,
  formatWavelength,
  formatWaveRange,
  MICRO,
  mjdToDate,
} from "@/lib/format";
import { DEFAULT_VIEW_FOV, VIEW_FOVS, type ViewFov } from "@/lib/fov";
import {
  type Band,
  DEFAULT_BAND,
  DEFAULT_MODE,
  DEFAULT_URL_STATE,
  serializeUrlState,
  useUrlState,
  VIEW_MODES,
  type ViewMode,
} from "@/state/urlState";
import { Button, ButtonLink } from "./Button";
import { DataGroup, DataRow } from "./DataRow";
import { GlassPanel } from "./GlassPanel";
import galleryEn from "./gallery.en.json";
import galleryEs from "./gallery.es.json";
import styles from "./gallery.module.css";
import { ICON_NAMES, Icon, type IconName } from "./Icon";
import { IconButton, IconLink } from "./IconButton";
import { ImageTag } from "./ImageTag";
import { LanguageSelector } from "./LanguageSelector";
import { ProgressBar } from "./ProgressBar";
import { groupNotices, type NoticeItem, QualityNotice, QualityNoticeList } from "./QualityNotice";
import { QuickLink, QuickLinkList } from "./QuickLink";
import { SearchField } from "./SearchField";
import { SegmentedControl } from "./SegmentedControl";
import { Slider } from "./Slider";
import {
  EPOCH_MARKER_STATES,
  EpochLegend,
  type EpochStatus,
  type TimelineEpoch,
  TimelineTrack,
} from "./Timeline";
import { Toggle } from "./Toggle";
import { Transport } from "./Transport";

// ---- Textos de la pagina ---------------------------------------------------

/** Namespace de i18next de los textos de esta pagina. */
const TEXTS_NAMESPACE = "gallery";

const TEXTS: Record<Language, typeof galleryEs> = { es: galleryEs, en: galleryEn };

registerDevTexts(TEXTS_NAMESPACE, TEXTS);

// ---- Datos de muestra ------------------------------------------------------

/**
 * Plano de muestra para el fondo: WISE 0855, epoca 2, detector 6. Se pide por
 * su ruta en el servidor de desarrollo y no con un `import ... ?url`: Vite
 * copia a dist/ todo archivo importado asi, aunque esta pagina no llegue al
 * sitio compilado.
 */
const PLANE_URL = "/src/test/fixtures/wise0855/plane_e2_d6.f32";

/** Lado, en pixeles, del plano de muestra (grid.shape de wise0855/meta.json). */
const PLANE_SIDE = 195;

/** Rangos de los detectores, en micrometros (detectors[] de los campos de muestra). */
const DETECTORS: ReadonlyArray<{ detector: Band; min: number; max: number }> = [
  { detector: 1, min: 0.7455, max: 1.1167 },
  { detector: 2, min: 1.1033, max: 1.6499 },
  { detector: 3, min: 1.6301, max: 2.4346 },
  { detector: 4, min: 2.4027, max: 3.8473 },
  { detector: 5, min: 3.8113, max: 4.43 },
  { detector: 6, min: 4.4115, max: 5.0096 },
];

/** Inicio de cada epoca, en MJD: las cuatro de Epsilon Indi B y las tres de WISE 0855. */
const FOUR_EPOCHS: ReadonlyArray<{ mjd: number; status: EpochStatus }> = [
  { mjd: 60789.85552, status: "loaded" },
  { mjd: 60946.96411, status: "loaded" },
  { mjd: 61148.84479, status: "provisional" },
  { mjd: 61305.22691, status: "unloaded" },
];

const THREE_EPOCHS: ReadonlyArray<{ mjd: number; status: EpochStatus }> = [
  { mjd: 60800.70003, status: "loaded" },
  { mjd: 60979.72268, status: "loaded" },
  { mjd: 61151.19793, status: "provisional" },
];

/**
 * Las cuatro epocas de Epsilon Indi B con la segunda corrida a 61 dias de la
 * primera, para ver la separacion minima entre marcas; no es un campo real. La
 * ultima va sin datos, como la epoca 4 de ese campo en las bandas 1 y 4.
 */
const CLOSE_EPOCHS: ReadonlyArray<{ mjd: number; status: EpochStatus }> = [
  { mjd: 60789.85552, status: "loaded" },
  { mjd: 60850.85552, status: "loaded" },
  { mjd: 61148.84479, status: "unloaded" },
  { mjd: 61305.22691, status: "empty" },
];

/** Centro del campo de Epsilon Indi B (request de epsindb/meta.json). */
const SAMPLE_FIELD = { ra: 331.0966, dec: -56.8006, pixelScaleArcsec: 3.075 };

/**
 * Objetos destacados con centro de campo verificado (docs/contrato-cubo.md,
 * SPEC.md y los campos de muestra). El movimiento propio va en segundos de
 * arco por anio.
 */
interface FeaturedObject {
  readonly name: string;
  readonly ra: number;
  readonly dec: number;
  readonly band: Band;
  readonly motion: number | null;
}

const BARNARD: FeaturedObject = {
  name: "Barnard's Star",
  ra: 269.4463,
  dec: 4.7683,
  band: 3,
  motion: 10.39,
};

const EPSILON_INDI_B: FeaturedObject = {
  name: "Epsilon Indi B",
  ra: SAMPLE_FIELD.ra,
  dec: SAMPLE_FIELD.dec,
  band: 3,
  motion: null,
};

const WISE_0855: FeaturedObject = {
  name: "WISE 0855",
  ra: 133.7598,
  dec: -7.2422,
  band: 6,
  motion: 8.1,
};

const FEATURED: readonly FeaturedObject[] = [BARNARD, EPSILON_INDI_B, WISE_0855];

const SPEEDS = [0.5, 1, 2] as const;

const TOOLS = ["bands", "blink", "contrast", "fov"] as const satisfies readonly IconName[];

/** Un nombre mal escrito, para mostrar el campo de busqueda con error. */
const TYPO_QUERY = "Barnad Star";

const TIMES = String.fromCodePoint(0x00d7);
const MIDDLE_DOT = String.fromCodePoint(0x00b7);

function toTimeline(epochs: ReadonlyArray<{ mjd: number; status: EpochStatus }>): TimelineEpoch[] {
  return epochs.map((item, index) => ({
    epoch: index + 1,
    time: item.mjd,
    // Mes de inicio de la epoca: la fecha ISO sin el dia.
    dateLabel: formatMjdDate(item.mjd).slice(0, 7),
    status: item.status,
  }));
}

function viewerHref(target: FeaturedObject): string {
  return `/${serializeUrlState({
    ...DEFAULT_URL_STATE,
    ra: target.ra,
    dec: target.dec,
    fov: DEFAULT_VIEW_FOV,
    band: target.band,
    mode: DEFAULT_MODE,
    name: target.name,
  })}`;
}

// ---- Fondo: un plano real de SPHEREx ---------------------------------------

/**
 * Dibuja un plano del contrato en escala de grises. La fila 0 es el sur, asi
 * que se recorre de arriba hacia abajo para dejar el norte arriba.
 */
function drawPlane(canvas: HTMLCanvasElement, values: Float32Array, side: number): void {
  const context = canvas.getContext("2d");
  if (context === null || values.length !== side * side) return;

  const finite = values.filter((value) => Number.isFinite(value)).sort();
  const low = finite[Math.floor(finite.length * 0.01)] ?? 0;
  const high = finite[Math.floor(finite.length * 0.997)] ?? 1;
  const range = high > low ? high - low : 1;
  const stretch = 10;

  const image = context.createImageData(side, side);
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      const value = values[(side - 1 - row) * side + column] ?? Number.NaN;
      const unit = Number.isFinite(value) ? Math.min(1, Math.max(0, (value - low) / range)) : 0;
      const level = Math.round((255 * Math.asinh(unit * stretch)) / Math.asinh(stretch));
      image.data.set([level, level, level, 255], (row * side + column) * 4);
    }
  }
  context.putImageData(image, 0, 0);
}

function SkyBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(PLANE_URL)
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(response.status)))
      .then((buffer) => {
        const canvas = canvasRef.current;
        if (!cancelled && canvas !== null) {
          drawPlane(canvas, new Float32Array(buffer), PLANE_SIDE);
        }
      })
      .catch(() => {
        // Sin la imagen de muestra queda el negro del lienzo.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Es decorativo y no tiene contenido de respaldo: los lectores de pantalla lo saltean.
  return (
    <canvas ref={canvasRef} className={styles.backdrop} width={PLANE_SIDE} height={PLANE_SIDE} />
  );
}

// ---- Columnas --------------------------------------------------------------

function ControlsColumn() {
  const { t } = useTranslation("gallery");
  const { t: tViewer } = useTranslation("viewer");
  const language = useLanguage();

  const [band, setBand] = useState<Band>(DEFAULT_BAND);
  const [mode, setMode] = useState<ViewMode>(DEFAULT_MODE);
  const [fov, setFov] = useState<ViewFov>(DEFAULT_VIEW_FOV);
  const [speed, setSpeed] = useState<number>(1);
  const [contrast, setContrast] = useState(65);
  const [flags, setFlags] = useState(false);
  const [trail, setTrail] = useState(true);

  const side = formatArcminutes(fov, language);

  return (
    <div className={styles.column}>
      <GlassPanel title={t("band.title")} icon="bands" aside={`${MICRO}m`}>
        <SegmentedControl
          label={t("band.group")}
          columns={3}
          value={band}
          onChange={setBand}
          options={DETECTORS.map((item) => ({
            value: item.detector,
            label: formatBand(item.detector),
            detail: formatWaveRange(item.min, item.max, language),
            noData: item.detector === 5,
            disabled: item.detector === 6,
          }))}
        />
        <p className={styles.caption}>{t("band.note")}</p>
      </GlassPanel>

      <GlassPanel title={t("mode.title")} icon="blink">
        <SegmentedControl
          label={t("mode.group")}
          columns={2}
          value={mode}
          onChange={setMode}
          options={VIEW_MODES.map((item) => ({ value: item, label: tViewer(`mode.${item}`) }))}
        />
      </GlassPanel>

      <GlassPanel title={t("image.title")} icon="contrast">
        <Slider
          label={t("image.contrast")}
          value={contrast}
          onChange={setContrast}
          valueText={formatPercent(contrast / 100, language)}
        />
        <Slider
          label={t("state.disabled")}
          value={30}
          onChange={setContrast}
          valueText={formatPercent(0.3, language)}
          disabled
        />
        <SegmentedControl
          label={t("image.fov")}
          showLabel
          valueText={`${side} ${TIMES} ${side}`}
          value={fov}
          onChange={setFov}
          options={VIEW_FOVS.map((item) => ({
            value: item,
            label: formatArcminutes(item, language),
          }))}
        />
        <div>
          <Toggle label={t("image.flags")} checked={flags} onChange={setFlags} />
          <Toggle label={t("image.trail")} checked={trail} onChange={setTrail} />
          <Toggle label={t("state.disabled")} checked={false} onChange={setFlags} disabled />
        </div>
      </GlassPanel>

      <GlassPanel title={t("speed.title")} icon="play">
        <SegmentedControl
          label={t("speed.group")}
          value={speed}
          onChange={setSpeed}
          options={SPEEDS.map((item) => ({
            value: item,
            label: `${formatDecimal(item, language, Number.isInteger(item) ? 0 : 1)}${TIMES}`,
          }))}
        />
        <SegmentedControl
          label={t("state.disabled")}
          showLabel
          value={1}
          onChange={setSpeed}
          disabled
          options={SPEEDS.map((item) => ({
            value: item,
            label: `${formatDecimal(item, language, Number.isInteger(item) ? 0 : 1)}${TIMES}`,
          }))}
        />
      </GlassPanel>
    </div>
  );
}

function StageColumn() {
  const { t } = useTranslation("gallery");
  const language = useLanguage();

  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [epoch, setEpoch] = useState(2);
  const [epochOfThree, setEpochOfThree] = useState(3);
  const [epochOfClose, setEpochOfClose] = useState(3);
  const [tool, setTool] = useState<(typeof TOOLS)[number]>("bands");

  const fourEpochs = toTimeline(FOUR_EPOCHS);
  const threeEpochs = toTimeline(THREE_EPOCHS);
  const closeEpochs = toTimeline(CLOSE_EPOCHS);
  const currentMjd = FOUR_EPOCHS[epoch - 1]?.mjd ?? Number.NaN;
  const example = `${BARNARD.name}  ${MIDDLE_DOT}  ${formatRa(BARNARD.ra, { language })} ${formatDec(BARNARD.dec, { language })}`;

  function step(delta: number): void {
    setEpoch((value) => ((value - 1 + delta + FOUR_EPOCHS.length) % FOUR_EPOCHS.length) + 1);
  }

  return (
    <div className={styles.column}>
      <section className={styles.stage} aria-label={t("imageTag.title")}>
        <h2 className={styles.stageTitle}>{t("imageTag.title")}</h2>
        <ImageTag
          label={t("imageTag.provisional")}
          value={t("imageTag.exposures", {
            used: formatInteger(9),
            total: formatInteger(18),
          })}
        />
        <ImageTag
          label={t("imageTag.preview")}
          value={t("imageTag.survey", { wave: formatWavelength(3.4, language, 1) })}
          note={t("imageTag.note")}
        />
      </section>

      <section className={styles.stage} aria-label={t("search.title")}>
        <h2 className={styles.stageTitle}>{t("search.title")}</h2>
        <SearchField
          label={t("search.label")}
          value={query}
          onChange={setQuery}
          onSubmit={setSubmitted}
          submitLabel={t("search.submit")}
          placeholder={example}
          hint={submitted === null ? t("search.hint") : t("search.submitted", { query: submitted })}
        />
        <SearchField
          label={t("search.label")}
          value={TYPO_QUERY}
          onChange={setQuery}
          onSubmit={setSubmitted}
          submitLabel={t("search.submit")}
          error={t("search.error")}
        />
        <SearchField
          label={t("search.label")}
          value={WISE_0855.name}
          onChange={setQuery}
          onSubmit={setSubmitted}
          submitLabel={t("search.submit")}
          busy
        />
        <p className={styles.stageTitle}>{t("search.featured")}</p>
        <QuickLinkList label={t("search.featuredNav")}>
          {FEATURED.map((item) => (
            <QuickLink
              key={item.name}
              href={viewerHref(item)}
              detail={
                item.motion === null
                  ? undefined
                  : t("search.motion", {
                      value: formatArcseconds(item.motion, language),
                    })
              }
            >
              {item.name}
            </QuickLink>
          ))}
        </QuickLinkList>
      </section>

      <GlassPanel title={t("timeline.title")} icon="compass">
        <div className={styles.row}>
          <Transport
            playing={playing}
            onPlayingChange={setPlaying}
            onPrevious={() => step(-1)}
            onNext={() => step(1)}
          />
          <div className={styles.grow}>
            <p className={styles.epochHeader}>
              <span className="type-label-cap">
                {t("timeline.position", {
                  n: formatInteger(epoch),
                  total: formatInteger(FOUR_EPOCHS.length),
                })}
              </span>
              <span className={styles.epochDate}>{formatIsoDateTime(mjdToDate(currentMjd))}</span>
            </p>
            <TimelineTrack
              label={t("timeline.title")}
              epochs={fourEpochs}
              current={epoch}
              onSelect={setEpoch}
            />
          </div>
        </div>
        {/* Las referencias por defecto son las cuatro de DESIGN.md; aca van todas. */}
        <EpochLegend states={EPOCH_MARKER_STATES} />
        <p className={styles.caption}>{t("timeline.threeEpochs")}</p>
        <TimelineTrack
          label={t("timeline.threeEpochs")}
          epochs={threeEpochs}
          current={epochOfThree}
          onSelect={setEpochOfThree}
        />
        <p className={styles.caption}>{t("timeline.closeEpochs")}</p>
        <TimelineTrack
          label={t("timeline.closeEpochs")}
          epochs={closeEpochs}
          current={epochOfClose}
          onSelect={setEpochOfClose}
        />
        <ProgressBar
          label={t("progress.loading")}
          value={14 / 22}
          valueText={t("progress.cutouts", {
            done: formatInteger(14),
            total: formatInteger(22),
            percent: formatPercent(14 / 22, language),
          })}
        />
        <ProgressBar
          label={t("progress.queued")}
          value={null}
          valueText={t("progress.position", { n: formatInteger(2) })}
        />
        <ProgressBar label={t("progress.done")} value={1} valueText={formatPercent(1, language)} />
      </GlassPanel>

      <GlassPanel title={t("buttons.title")} icon="target">
        <div className={styles.row}>
          <Button variant="primary">{t("buttons.open")}</Button>
          <Button icon="shuffle">{t("buttons.random")}</Button>
          <ButtonLink href={viewerHref(WISE_0855)}>{t("buttons.link")}</ButtonLink>
        </div>
        <div className={styles.row}>
          <Button variant="primary" disabled>
            {t("state.disabled")}
          </Button>
          <Button icon="share" disabled>
            {t("state.disabled")}
          </Button>
        </div>
        <div className={styles.row}>
          <IconLink icon="back" label={t("buttons.back")} href="/" />
          <IconButton icon="share" label={t("buttons.share")} />
          <IconButton icon="layers" label={t("buttons.layers")} pressed />
          <IconButton icon="close" label={t("buttons.close")} variant="bare" />
          <IconButton icon="sound" label={t("state.disabled")} disabled />
          <IconButton icon="minus" label={t("buttons.zoomOut")} size="sm" shape="square" />
          <IconButton icon="plus" label={t("buttons.zoomIn")} size="sm" shape="square" />
        </div>
        <div className={styles.row}>
          <Transport
            playing={false}
            onPlayingChange={setPlaying}
            onPrevious={() => step(-1)}
            onNext={() => step(1)}
            playSize="lg"
            label={t("state.paused")}
          />
          <Transport
            playing
            onPlayingChange={setPlaying}
            onPrevious={() => step(-1)}
            onNext={() => step(1)}
            playSize="xl"
            label={t("state.playing")}
          />
          <Transport
            playing={false}
            onPlayingChange={setPlaying}
            onPrevious={() => step(-1)}
            onNext={() => step(1)}
            disabled
            label={t("state.disabled")}
          />
        </div>
        <div className={styles.rail}>
          {TOOLS.map((name) => (
            <IconButton
              key={name}
              icon={name}
              label={t(`tools.${name}`)}
              shape="square"
              pressed={tool === name}
              onClick={() => setTool(name)}
            />
          ))}
        </div>
      </GlassPanel>

      <GlassPanel title={t("icons.title")} icon="info" aside={formatInteger(ICON_NAMES.length)}>
        <ul className={styles.icons}>
          {ICON_NAMES.map((name) => (
            <li key={name} className={styles.iconCell}>
              <Icon name={name} size={24} />
              <span className={styles.iconName}>{name}</span>
            </li>
          ))}
        </ul>
      </GlassPanel>
    </div>
  );
}

function InfoColumn() {
  const { t } = useTranslation("gallery");
  const language = useLanguage();
  const band = DETECTORS[2];
  const side = formatArcminutes(DEFAULT_VIEW_FOV, language);

  const notices: NoticeItem[] = [
    { text: t("notices.saturated") },
    ...DETECTORS.map(() => ({ key: "few-exposures", text: t("notices.fewExposures") })),
    { text: t("notices.provisional") },
  ];

  return (
    <div className={styles.column}>
      <GlassPanel title={t("metadata.title")} icon="info">
        <DataGroup>
          <DataRow label={t("metadata.object")} value={EPSILON_INDI_B.name} truncate />
          <DataRow label={t("metadata.ra")} value={formatRa(SAMPLE_FIELD.ra, { language })} />
          <DataRow label={t("metadata.dec")} value={formatDec(SAMPLE_FIELD.dec, { language })} />
          <DataRow
            label={t("metadata.epoch")}
            value={formatIsoDateTime(mjdToDate(FOUR_EPOCHS[1]?.mjd ?? Number.NaN))}
          />
          <DataRow
            label={t("metadata.band")}
            value={
              band === undefined
                ? ""
                : `${formatBand(band.detector)} ${MIDDLE_DOT} ${formatWaveRange(band.min, band.max, language)} ${MICRO}m`
            }
          />
          <DataRow
            label={t("metadata.pixelScale")}
            value={formatArcseconds(SAMPLE_FIELD.pixelScaleArcsec, language, 3)}
          />
          <DataRow label={t("metadata.field")} value={`${side} ${TIMES} ${side}`} />
          <DataRow label={t("metadata.epochs")} value={formatInteger(FOUR_EPOCHS.length)} />
          <DataRow label={t("metadata.source")} value={`SPHEREx ${MIDDLE_DOT} IRSA`} truncate />
        </DataGroup>
      </GlassPanel>

      <GlassPanel
        title={t("notices.title")}
        icon="alert"
        aside={formatInteger(groupNotices(notices).length)}
      >
        <QualityNoticeList notices={notices} />
      </GlassPanel>

      <GlassPanel title={t("notices.title")} icon="alert" aside={formatInteger(0)}>
        <QualityNoticeList notices={[]} emptyText={t("notices.empty")} />
      </GlassPanel>

      <GlassPanel label={t("notices.single")}>
        <QualityNotice>{t("notices.provisional")}</QualityNotice>
      </GlassPanel>

      <GlassPanel title={t("padding.title")} padding="roomy">
        <p className={styles.body}>{t("padding.body")}</p>
      </GlassPanel>
    </div>
  );
}

// ---- Pagina ----------------------------------------------------------------

function Gallery() {
  const { t } = useTranslation("gallery");
  const { t: tCommon } = useTranslation("common");
  const language = useLanguage();
  const updateUrl = useUrlState((state) => state.update);

  return (
    <div className={styles.page}>
      <SkyBackdrop />
      <div className={styles.content}>
        <header className={styles.topBar}>
          <div className={styles.brand}>
            <span className={styles.brandName}>{tCommon("app.name")}</span>
            <h1 className={styles.title}>{t("title")}</h1>
          </div>
          {/* El idioma va en la URL (`lang`); App lo aplica a i18next. */}
          <LanguageSelector value={language} onChange={(lang) => updateUrl({ lang })} />
        </header>
        <main className={styles.columns}>
          <ControlsColumn />
          <StageColumn />
          <InfoColumn />
        </main>
      </div>
    </div>
  );
}

export const devPage: DevPage = { Component: Gallery };
