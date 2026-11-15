// Busqueda y objetos destacados de la pantalla de entrada.
//
// La pantalla en si es la esfera celeste (src/features/sphere, `SpherePage`),
// que es lo que App.tsx muestra cuando la URL no trae coordenadas. De aca salen
// su logica de busqueda (`useObjectSearch`) y la lista de los cinco objetos de
// prueba (`FEATURED_OBJECTS`), que es la unica: la esfera la usa para sus
// marcadores y para "Lugar al azar" (src/features/sphere/targets.ts).

export {
  FEATURED_OBJECTS,
  type FeaturedObject,
  featuredUrlPatch,
  resolvableName,
  SEARCH_EXAMPLE,
  typedCoordinates,
  type ViewerUrlPatch,
  viewerHref,
} from "./featured";
export {
  type FoundPlace,
  type ObjectSearch,
  type SearchResult,
  type SearchStatus,
  useObjectSearch,
} from "./useObjectSearch";
