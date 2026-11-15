// Esfera celeste de la entrada (SPEC.md, Etapa 4).
//
// `SpherePage` es la pantalla de entrada de la aplicacion: esfera, marcadores,
// buscador y "Lugar al azar". App.tsx la muestra cuando la URL no trae
// coordenadas. La logica del buscador y la lista de objetos destacados salen de
// src/features/entry.
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
export { PRECOMPUTED_FIELDS, SKY_TARGETS, type SkyTarget } from "./targets";
