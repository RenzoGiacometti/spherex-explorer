import { type MouseEvent, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { LanguageSelector, QuickLink, QuickLinkList, SearchField } from "@/components";
import type { NameResolver } from "@/data/nameResolver";
import { useLanguage } from "@/i18n/useLanguage";
import { formatDecimal, formatWavelength } from "@/lib/format";
import { DEFAULT_URL_STATE, useUrlState } from "@/state/urlState";
import styles from "./EntryPage.module.css";
import {
  FEATURED_OBJECTS,
  type FeaturedObject,
  featuredUrlPatch,
  SEARCH_EXAMPLE,
  typedCoordinates,
  viewerHref,
} from "./featured";
import { useObjectSearch } from "./useObjectSearch";

/**
 * Rango espectral de la mision en micrometros, como lo nombra DESIGN.md
 * ("Eje X de 0,75 a 5 um"). Los detectores cubren de 0,75 a 5,01 (SPEC.md,
 * seccion 2).
 */
const MISSION_WAVE_RANGE_UM = { min: 0.75, max: 5 } as const;

export interface EntryPageProps {
  /**
   * Resolucion de nombres. Por defecto, la que comparte con el visor
   * (src/data/nameResolver.ts); los tests pasan una propia.
   */
  readonly resolver?: NameResolver | undefined;
}

/**
 * Pantalla de entrada: lo que se ve cuando la URL no trae coordenadas. Titular,
 * buscador por nombre o coordenadas y los cinco objetos destacados. El fondo es
 * el negro del lienzo: la esfera celeste llega con la Etapa 4.
 */
export function EntryPage({ resolver }: EntryPageProps) {
  const { t } = useTranslation("entry");
  const { t: tCommon } = useTranslation("common");
  const { t: tErrors } = useTranslation("errors");
  const language = useLanguage();

  const urlLanguage = useUrlState((state) => state.lang);
  const embed = useUrlState((state) => state.embed);
  const updateUrl = useUrlState((state) => state.update);

  const [query, setQuery] = useState("");
  const search = useObjectSearch(resolver);
  const { status } = search;
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(text: string): Promise<void> {
    const outcome = await search.submit(text);
    // Despues de un fallo el foco vuelve al campo, para corregir o reintentar.
    if (outcome === "failed") inputRef.current?.focus();
  }

  function handleQueryChange(value: string): void {
    setQuery(value);
    // Al editar se suelta la busqueda anterior: su error o su pedido en camino.
    if (status.kind !== "idle") search.reset();
  }

  function openFeatured(event: MouseEvent<HTMLAnchorElement>, object: FeaturedObject): void {
    // Con una tecla modificadora, o con otro boton, el navegador abre el link por su cuenta.
    const plainClick =
      event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (event.defaultPrevented || !plainClick) return;
    event.preventDefault();
    search.reset();
    updateUrl(featuredUrlPatch(object), { history: "push" });
  }

  const example = t("search.example", {
    name: SEARCH_EXAMPLE.label,
    coordinates: typedCoordinates(SEARCH_EXAMPLE),
  });

  const resolvingText =
    status.kind === "resolving" ? t("search.resolving", { query: status.query }) : undefined;

  let errorText: string | undefined;
  if (status.kind === "error") {
    const message = tErrors(`code.${status.code}`);
    // Los dos fallos que tienen una salida a mano la dicen al lado del motivo.
    const advice =
      status.code === "not_resolved" || status.code === "upstream_unavailable"
        ? t(`search.advice.${status.code}`)
        : null;
    errorText = advice === null ? message : `${message} ${advice}`;
  }

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <p className={styles.brand}>{tCommon("app.name")}</p>
        {/* El idioma va en la URL (`lang`); App lo aplica a i18next. */}
        <LanguageSelector value={language} onChange={(lang) => updateUrl({ lang })} />
      </header>

      <main className={styles.main}>
        <div className={styles.intro}>
          <p className={styles.kicker}>
            {/*
              La etiqueta va en mayusculas, pero no todo: el nombre de la mision
              conserva su escritura y el rango va en mono. En mayusculas, la
              unidad de micrometros se leia como milimetros.
            */}
            <Trans
              t={t}
              i18nKey="kicker"
              values={{
                from: formatDecimal(MISSION_WAVE_RANGE_UM.min, language, 2),
                to: formatWavelength(MISSION_WAVE_RANGE_UM.max, language, 0),
              }}
              components={{
                mission: <span className={styles.asWritten} />,
                range: <span className={styles.kickerRange} />,
              }}
            />
          </p>
          <h1 className={styles.headline}>{t("headline")}</h1>
          <p className={styles.lead}>{t("lead")}</p>
        </div>

        <div className={styles.search}>
          <SearchField
            label={t("search.label")}
            value={query}
            onChange={handleQueryChange}
            onSubmit={(text) => void handleSubmit(text)}
            submitLabel={t("search.submit")}
            placeholder={example}
            hint={resolvingText}
            error={errorText}
            busy={status.kind === "resolving"}
            inputRef={inputRef}
          />
          {/* Siempre montado, para que el lector de pantalla anuncie el cambio de texto. */}
          <p className={styles.visuallyHidden} role="status">
            {resolvingText}
          </p>
        </div>

        <div className={styles.featured}>
          <h2 className={styles.featuredTitle}>{t("featured.title")}</h2>
          <QuickLinkList label={t("featured.nav")}>
            {FEATURED_OBJECTS.map((object) => (
              <QuickLink
                key={object.id}
                href={viewerHref({
                  ...DEFAULT_URL_STATE,
                  embed,
                  lang: urlLanguage,
                  ...featuredUrlPatch(object),
                })}
                onClick={(event) => openFeatured(event, object)}
              >
                {object.label}
              </QuickLink>
            ))}
          </QuickLinkList>
        </div>
      </main>
    </div>
  );
}
