// Pagina de prueba de la esfera: /?dev=sphere con `pnpm dev`.
//
// Muestra la pantalla de entrada con la esfera sin el resto de la aplicacion.
// Elegir un lugar (marcador, buscador o "Lugar al azar") hace el acercamiento y
// despues carga la URL del visor con esas coordenadas, ya sin `dev`.
//
// Parametros de la URL, ademas de `lang`:
//
//   view=ra,dec,fov   vista inicial en grados; `fov` es opcional
//   drift=0           sin la deriva inicial (para capturas repetibles)
//   check=1           marcas blancas sobre diez estrellas brillantes: si la
//                     textura esta bien orientada, cada anillo rodea a su
//                     estrella. Es la comprobacion de que la imagen y los
//                     marcadores usan la misma convencion.
//   sensor=1          muestra "Ventana al cielo" tambien en una computadora y
//                     acepta los sensores simulados de las herramientas de
//                     desarrollo (More tools > Sensors), que no traen brujula
//
// El buscador necesita el backend (o el servidor falso) en /api; los cinco
// marcadores y "Lugar al azar" no.

import type { DevPage } from "@/dev/devPages";
import { DEFAULT_URL_STATE, useUrlState } from "@/state/urlState";
import { DEFAULT_FOV, type SkyView } from "./SkyScene";
import type { SkyMarker } from "./SkySphere";
import { SpherePage } from "./SpherePage";
import { type FieldUrlPatch, viewerHref } from "./targets";

/**
 * Estrellas brillantes repartidas por todo el cielo, en grados ICRS (J2000).
 * Son las mismas con las que se comprobo la orientacion de la textura
 * (assets/FUENTES.md).
 */
const BRIGHT_STARS: readonly SkyMarker[] = [
  { id: "probe-sirius", label: "Sirius", ra: 101.2872, dec: -16.7161 },
  { id: "probe-canopus", label: "Canopus", ra: 95.988, dec: -52.6957 },
  { id: "probe-arcturus", label: "Arcturus", ra: 213.9153, dec: 19.1824 },
  { id: "probe-vega", label: "Vega", ra: 279.2347, dec: 38.7837 },
  { id: "probe-capella", label: "Capella", ra: 79.1723, dec: 45.998 },
  { id: "probe-rigel", label: "Rigel", ra: 78.6345, dec: -8.2016 },
  { id: "probe-procyon", label: "Procyon", ra: 114.8255, dec: 5.225 },
  { id: "probe-betelgeuse", label: "Betelgeuse", ra: 88.7929, dec: 7.4071 },
  { id: "probe-achernar", label: "Achernar", ra: 24.4285, dec: -57.2368 },
  { id: "probe-altair", label: "Altair", ra: 297.6958, dec: 8.8683 },
].map((star) => ({ ...star, kind: "probe" as const }));

function parseView(text: string | null): SkyView | undefined {
  if (text === null) return undefined;
  const [ra, dec, fov = DEFAULT_FOV] = text.split(",").map(Number);
  if (ra === undefined || dec === undefined) return undefined;
  if (![ra, dec, fov].every(Number.isFinite)) return undefined;
  return { ra, dec, fov };
}

function parseNumber(text: string | null): number | undefined {
  if (text === null || text.trim() === "") return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** Carga la URL del visor, sin `dev`: asi se ve el visor de verdad con ese campo. */
function openInViewer(patch: FieldUrlPatch): void {
  const { embed, lang } = useUrlState.getState();
  window.location.assign(viewerHref({ ...DEFAULT_URL_STATE, embed, lang, ...patch }));
}

function SphereDevPage() {
  const params = new URLSearchParams(window.location.search);
  const sensor = params.get("sensor") === "1";
  return (
    <SpherePage
      initialView={parseView(params.get("view"))}
      driftRate={parseNumber(params.get("drift"))}
      extraMarkers={params.get("check") === "1" ? BRIGHT_STARS : undefined}
      offerSkyWindow={sensor ? true : undefined}
      allowRelativeOrientation={sensor}
      onOpenField={openInViewer}
    />
  );
}

export const devPage: DevPage = { Component: SphereDevPage };
