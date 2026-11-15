// Esfera celeste de la entrada (SPEC.md, Etapa 4).
//
// `SpherePage` es la pantalla completa: esfera, marcadores, buscador y "Lugar
// al azar". Para que sea la entrada de la aplicacion alcanza con exportarla
// como `EntryPage` desde src/features/entry/index.ts.
//
// `SkySphere` es solo el cielo con sus marcadores, por si otra pantalla lo
// quiere de fondo. La pagina de prueba esta en /?dev=sphere.

export type { FlyOptions, SkyView } from "./SkyScene";
export {
  type SkyMarker,
  SkySphere,
  type SkySphereHandle,
  type SkySphereProps,
  type SkySphereStatus,
} from "./SkySphere";
export { SpherePage, type SpherePageProps } from "./SpherePage";
export {
  type FieldUrlPatch,
  PRECOMPUTED_FIELDS,
  SKY_TARGETS,
  type SkyTarget,
  targetUrlPatch,
} from "./targets";
