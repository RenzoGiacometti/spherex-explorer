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
//                     marcadores usan la misma convencion. Suma marcas sobre
//                     dos parches (PATCH_PROBES): acercando a Barnard's Star y
//                     a M 51, cada anillo tiene que rodear a su objeto.
//   random=0.81       valor fijo para "Lugar al azar", de 0 a 1 (0.81 es
//                     M 51): capturas repetibles de un campo sin marcador
//   stay=1            al terminar el acercamiento no carga el visor: la
//                     esfera queda sobre la imagen del campo y despues vuelve
//   sensor=1          muestra "Ventana al cielo" tambien en una computadora y
//                     acepta los sensores simulados de las herramientas de
//                     desarrollo (More tools > Sensors), que no traen brujula
//
// El buscador necesita el backend (o el servidor falso) en /api; los cinco
// marcadores y "Lugar al azar" no.

import type { DevPage } from "@/dev/devPages";
import { type ViewerUrlPatch, viewerHref } from "@/features/entry";
import { DEFAULT_URL_STATE, useUrlState } from "@/state/urlState";
import { DEFAULT_FOV, type SkyView } from "./SkyScene";
import type { SkyMarker } from "./SkySphere";
import { SpherePage } from "./SpherePage";

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

/**
 * Objetos que se reconocen dentro de dos parches, para comprobar que la imagen
 * del campo esta orientada como el cielo (norte arriba, este a la izquierda).
 *
 * - M 51: el nucleo de la companera NGC 5195 (SIMBAD, ICRS), que queda al
 *   norte y un poco al este del centro del campo.
 * - Barnard's Star: tres estrellas vecinas de Gaia DR3
 *   (backend/data/context/269.4463_+4.7683_0.1667/gaia.json), con la posicion
 *   llevada de 2016,0 a 2026,2, la fecha de la epoca del parche.
 */
const PATCH_PROBES: readonly SkyMarker[] = [
  { id: "probe-ngc-5195", label: "NGC 5195", ra: 202.4983, dec: 47.2661 },
  { id: "probe-barnard-s", label: "Gaia DR3 4472832165289153024", ra: 269.46646, dec: 4.70555 },
  { id: "probe-barnard-ne", label: "Gaia DR3 4472837942025804800", ra: 269.48417, dec: 4.83176 },
  { id: "probe-barnard-w", label: "Gaia DR3 4472835807421415680", ra: 269.39214, dec: 4.77215 },
].map((probe) => ({ ...probe, kind: "probe" as const }));

const CHECK_MARKERS: readonly SkyMarker[] = [...BRIGHT_STARS, ...PATCH_PROBES];

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
function openInViewer(patch: ViewerUrlPatch): void {
  const { embed, lang } = useUrlState.getState();
  window.location.assign(viewerHref({ ...DEFAULT_URL_STATE, embed, lang, ...patch }));
}

/** Con `stay=1`: el acercamiento termina y la esfera sigue en pantalla. */
function keepSphere(): void {}

function SphereDevPage() {
  const params = new URLSearchParams(window.location.search);
  const sensor = params.get("sensor") === "1";
  const random = parseNumber(params.get("random"));
  const stay = params.get("stay") === "1";
  return (
    <SpherePage
      initialView={parseView(params.get("view"))}
      driftRate={parseNumber(params.get("drift"))}
      extraMarkers={params.get("check") === "1" ? CHECK_MARKERS : undefined}
      random={random === undefined ? undefined : () => random}
      offerSkyWindow={sensor ? true : undefined}
      allowRelativeOrientation={sensor}
      onOpenField={stay ? keepSphere : openInViewer}
    />
  );
}

export const devPage: DevPage = { Component: SphereDevPage };
