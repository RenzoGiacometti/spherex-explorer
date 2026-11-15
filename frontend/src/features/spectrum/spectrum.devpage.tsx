// Pagina de prueba del panel de espectro: /?dev=spectrum con `pnpm dev`.
//
// Muestra el panel con los espectros precalculados de los cinco objetos de
// prueba (fixtures/, copia de backend/data/spectra que escribe
// backend/scripts/precompute_spectra.py), sin el visor. Con el conmutador pide
// el mismo punto al backend, para probar la ruta de punta a punta:
//   uv run uvicorn app.spectrum.server:app --port 8000
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
          {loaded.state === "ready" ? (
            <DataGroup>
              <DataRow label={t("status")} value={loaded.spectrum.status} />
              <DataRow
                label={t("exposures")}
                value={formatInteger(loaded.spectrum.provenance.n_exposures)}
              />
              <DataRow label={t("points")} value={formatInteger(loaded.spectrum.points.length)} />
            </DataGroup>
          ) : null}
        </GlassPanel>
        {loaded.state === "loading" ? <p className={styles.note}>{t("loading")}</p> : null}
        {loaded.state === "error" ? (
          <p className={styles.note} role="alert">
            {t("error", { reason: loaded.reason })}
          </p>
        ) : null}
        {loaded.state === "ready" ? <SpectrumPanel spectrum={loaded.spectrum} /> : null}
      </main>
    </div>
  );
}

export const devPage: DevPage = { Component: SpectrumDevPage };
