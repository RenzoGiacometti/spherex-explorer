// Pagina de prueba del panel de espectro: /?dev=spectrum con `pnpm dev`.
//
// Muestra el panel con los espectros precalculados de los cinco objetos de
// prueba (fixtures/, copia de backend/data/spectra que escribe
// backend/scripts/precompute_spectra.py), sin el visor. Con el conmutador pide
// el mismo punto al backend, para probar la ruta de punta a punta:
//   uv run uvicorn app.spectrum.server:app --port 8000
//
// "Caso" arma a mano, sobre el documento elegido, las dos respuestas propias de
// un campo precalculado: el clic ajustado a una fuente guardada (aviso
// `snapped_source`) y el clic sin fuente guardada cerca (`status: "no_source"`).
//
// Los textos de la pagina estan al lado (spectrumDev.es.json y .en.json) y se
// registran al cargar este modulo: no viajan en el sitio compilado.

import { useEffect, useState } from "react";
import { isApiError } from "@/api/errors";
import {
  DataGroup,
  DataRow,
  GlassPanel,
  LanguageSelector,
  SegmentedControl,
  Toggle,
} from "@/components";
import type { DevPage } from "@/dev/devPages";
import { setLanguage } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { formatInteger } from "@/lib/format";
import { fetchSpectrum } from "./api";
import { SpectrumPanel } from "./SpectrumPanel";
import devEn from "./spectrumDev.en.json";
import devEs from "./spectrumDev.es.json";
import styles from "./spectrumDevPage.module.css";
import { registerTexts, useTexts } from "./texts";
import { parseSpectrum, type SpectrumDocument } from "./types";

const DEV_NAMESPACE = "spectrumDev";

registerTexts(DEV_NAMESPACE, { es: devEs, en: devEn });

// Nombres de catalogo: no se traducen.
const SAMPLES = [
  { id: "wise0855", name: "WISE 0855" },
  { id: "rwaur", name: "RW Aurigae" },
  { id: "epsindb", name: "Epsilon Indi B" },
  { id: "barnard", name: "Barnard's Star" },
  { id: "rdra", name: "R Draconis" },
] as const;

type SampleId = (typeof SAMPLES)[number]["id"];

const EXAMPLES = ["plain", "snapped", "noSource"] as const;

type ExampleId = (typeof EXAMPLES)[number];

/** Distancias de ejemplo, en segundos de arco: clic ajustado y fuente mas cercana. */
const EXAMPLE_SNAP_ARCSEC = 14.3;
const EXAMPLE_NEAREST_ARCSEC = 96.4;
const EXAMPLE_SAVED_SOURCES = 20;

/** El documento con la forma del caso elegido; pasa por `parseSpectrum`, como una respuesta. */
function asExample(spectrum: SpectrumDocument, example: ExampleId): SpectrumDocument {
  const { ra, dec } = spectrum.target;
  if (example === "snapped") {
    return parseSpectrum({
      ...spectrum,
      source: "precomputed",
      target: { ...spectrum.target, name: null },
      warnings: [
        ...spectrum.warnings,
        { code: "snapped_source", ra, dec, offset_arcsec: EXAMPLE_SNAP_ARCSEC },
      ],
    });
  }
  if (example === "noSource") {
    return parseSpectrum({
      ...spectrum,
      status: "no_source",
      target: { ...spectrum.target, name: null, motion: null, track: [] },
      epochs: [],
      detectors: [],
      points: [],
      binned: [],
      warnings: [],
      nearest: { ra, dec, offset_arcsec: EXAMPLE_NEAREST_ARCSEC },
      saved_sources: EXAMPLE_SAVED_SOURCES,
    });
  }
  return spectrum;
}

// Se cargan a pedido y sin tipo: pasan por `parseSpectrum`, como la respuesta del backend.
const fixtures = import.meta.glob<{ default: unknown }>("./fixtures/*.json");

async function loadFixture(id: SampleId): Promise<SpectrumDocument> {
  const loader = fixtures[`./fixtures/${id}.json`];
  if (loader === undefined) throw new Error(`fixtures/${id}.json`);
  return parseSpectrum((await loader()).default);
}

type Loaded =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly spectrum: SpectrumDocument }
  | { readonly state: "error"; readonly reason: string };

function reasonOf(error: unknown): string {
  if (isApiError(error)) return `${error.code} (${error.status})`;
  return error instanceof Error ? error.message : String(error);
}

function SpectrumDevPage() {
  const t = useTexts<typeof devEs>(DEV_NAMESPACE);
  const language = useLanguage();
  const [sample, setSample] = useState<SampleId>("wise0855");
  const [live, setLive] = useState(false);
  const [example, setExample] = useState<ExampleId>("plain");
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoaded({ state: "loading" });
    const load = async (): Promise<SpectrumDocument> => {
      const fixture = await loadFixture(sample);
      if (!live) return fixture;
      const { ra, dec, motion, epoch } = fixture.target;
      return fetchSpectrum(
        {
          ra,
          dec,
          pmRa: motion?.pm_ra ?? undefined,
          pmDec: motion?.pm_dec ?? undefined,
          epoch,
        },
        { signal: controller.signal },
      );
    };
    load().then(
      (spectrum) => {
        if (!cancelled) setLoaded({ state: "ready", spectrum });
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ state: "error", reason: reasonOf(error) });
      },
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sample, live]);

  // Lo que se muestra: el documento cargado, con la forma del caso elegido.
  const shown = loaded.state === "ready" ? asExample(loaded.spectrum, example) : null;

  return (
    <div className={styles.page}>
      <header className={styles.topBar}>
        <h1 className={styles.title}>{t("title")}</h1>
        <LanguageSelector value={language} onChange={(next) => void setLanguage(next)} />
      </header>
      <main className={styles.content}>
        <p className={styles.intro}>{t("intro")}</p>
        <GlassPanel label={t("object")}>
          <SegmentedControl
            label={t("object")}
            showLabel
            options={SAMPLES.map((item) => ({ value: item.id, label: item.name }))}
            value={sample}
            onChange={setSample}
            columns={5}
          />
          <Toggle label={t("live")} checked={live} onChange={setLive} />
          <p className={styles.note}>{live ? t("source.live") : t("source.fixture")}</p>
          <SegmentedControl
            label={t("example")}
            showLabel
            options={EXAMPLES.map((id) => ({ value: id, label: t(`examples.${id}`) }))}
            value={example}
            onChange={setExample}
            columns={3}
          />
          <p className={styles.note}>{t("exampleNote")}</p>
          {shown === null ? null : (
            <DataGroup>
              <DataRow label={t("status")} value={shown.status} />
              <DataRow label={t("exposures")} value={formatInteger(shown.provenance.n_exposures)} />
              <DataRow label={t("points")} value={formatInteger(shown.points.length)} />
            </DataGroup>
          )}
        </GlassPanel>
        {loaded.state === "loading" ? <p className={styles.note}>{t("loading")}</p> : null}
        {loaded.state === "error" ? (
          <p className={styles.note} role="alert">
            {t("error", { reason: loaded.reason })}
          </p>
        ) : null}
        {shown === null ? null : (
          <SpectrumPanel
            spectrum={shown}
            // La fuente mas cercana del ejemplo es el objeto elegido: se la muestra ajustada.
            onRequestPosition={() => setExample("snapped")}
          />
        )}
      </main>
    </div>
  );
}

export const devPage: DevPage = { Component: SpectrumDevPage };
