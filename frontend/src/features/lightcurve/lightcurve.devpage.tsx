// Pagina de prueba del panel de curva de luz: /?dev=lightcurve con `pnpm dev`.
//
// Muestra el panel con las curvas precalculadas de los cinco objetos de prueba
// (fixtures/, copia de backend/data/lightcurves que escribe
// backend/scripts/precompute_lightcurves.py), sin el visor. Con el conmutador
// pide el mismo punto al backend, para probar la ruta de punta a punta:
//   uv run uvicorn app.lightcurve.server:app --port 8000
//
// Los textos de la pagina estan al lado (lightcurveDev.es.json y .en.json) y se
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
import { fetchLightcurve } from "./api";
import { LightcurvePanel } from "./LightcurvePanel";
import devEn from "./lightcurveDev.en.json";
import devEs from "./lightcurveDev.es.json";
import styles from "./lightcurveDevPage.module.css";
import { registerTexts, useTexts } from "./texts";
import { type LightcurveDocument, parseLightcurve } from "./types";

const DEV_NAMESPACE = "lightcurveDev";

registerTexts(DEV_NAMESPACE, { es: devEs, en: devEn });

// Nombres de catalogo: no se traducen.
const SAMPLES = [
  { id: "rdra", name: "R Draconis" },
  { id: "rwaur", name: "RW Aurigae" },
  { id: "barnard", name: "Barnard's Star" },
  { id: "epsindb", name: "Epsilon Indi B" },
  { id: "wise0855", name: "WISE 0855" },
] as const;

type SampleId = (typeof SAMPLES)[number]["id"];

// Se cargan a pedido y sin tipo: pasan por `parseLightcurve`, como la respuesta del backend.
const fixtures = import.meta.glob<{ default: unknown }>("./fixtures/*.json");

async function loadFixture(id: SampleId): Promise<LightcurveDocument> {
  const loader = fixtures[`./fixtures/${id}.json`];
  if (loader === undefined) throw new Error(`fixtures/${id}.json`);
  return parseLightcurve((await loader()).default);
}

type Loaded =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly lightcurve: LightcurveDocument }
  | { readonly state: "error"; readonly reason: string };

function reasonOf(error: unknown): string {
  if (isApiError(error)) return `${error.code} (${error.status})`;
  return error instanceof Error ? error.message : String(error);
}

function LightcurveDevPage() {
  const t = useTexts<typeof devEs>(DEV_NAMESPACE);
  const language = useLanguage();
  const [sample, setSample] = useState<SampleId>("rdra");
  const [live, setLive] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoaded({ state: "loading" });
    const load = async (): Promise<LightcurveDocument> => {
      const fixture = await loadFixture(sample);
      if (!live) return fixture;
      const { ra, dec, motion, epoch } = fixture.target;
      return fetchLightcurve(
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
      (lightcurve) => {
        if (!cancelled) setLoaded({ state: "ready", lightcurve });
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
              <DataRow label={t("status")} value={loaded.lightcurve.status} />
              <DataRow label={t("verdict")} value={loaded.lightcurve.variability.verdict} />
              <DataRow
                label={t("exposures")}
                value={formatInteger(loaded.lightcurve.provenance.n_exposures)}
              />
            </DataGroup>
          ) : null}
        </GlassPanel>
        {loaded.state === "loading" ? <p className={styles.note}>{t("loading")}</p> : null}
        {loaded.state === "error" ? (
          <p className={styles.note} role="alert">
            {t("error", { reason: loaded.reason })}
          </p>
        ) : null}
        {loaded.state === "ready" ? <LightcurvePanel lightcurve={loaded.lightcurve} /> : null}
      </main>
    </div>
  );
}

export const devPage: DevPage = { Component: LightcurveDevPage };
