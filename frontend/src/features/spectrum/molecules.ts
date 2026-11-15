// Bandas moleculares que se marcan en el espectro, entre 0,75 y 5 um.
//
// Son las absorciones anchas que la resolucion de SPHEREx (R de 35 a 130)
// alcanza a ver en estrellas frias y enanas marrones:
//
// - H2O en 1,4 y 1,9 um y CH4 en 1,6, 2,2 y 3,3 um: Cushing, Rayner y Vacca
//   2005, "An Infrared Spectroscopic Sequence of M, L, and T Dwarfs"
//   (ApJ 623, 1115).
// - CO2 en 4,2 um y CO (banda fundamental) en 4,6 um: Yamamura, Tsuji y Tanabe
//   2010, "AKARI Observations of Brown Dwarfs. I. CO and CO2 Bands in the
//   Near-infrared Spectra" (ApJ 722, 682).
// - H2O entre 2,5 y 3,1 um: la banda de vapor en 2,7 um y la del hielo en
//   3,05 um, uno de los hielos que SPHEREx busca.
//
// Los limites de cada banda estan redondeados a la resolucion del instrumento.
// La banda de CO en 2,3 um no se marca: cae sobre la de CH4 y con esta
// resolucion no se distinguen.
//
// Cada banda puede llevar ventanas de continuo a los costados: con ellas se
// calcula la huella quimica (fingerprint.ts). Una banda sin ventanas solo se
// dibuja.

export type MoleculeId = "h2o" | "ch4" | "co2" | "co";

export const MOLECULE_IDS: readonly MoleculeId[] = ["h2o", "ch4", "co2", "co"];

// Subindices tipograficos, armados por codigo para que no dependan de la codificacion del archivo.
const SUB_2 = String.fromCodePoint(0x2082);
const SUB_4 = String.fromCodePoint(0x2084);

/** Formula de cada molecula, como se rotula en el grafico. No se traduce. */
export const MOLECULE_FORMULA: Record<MoleculeId, string> = {
  h2o: `H${SUB_2}O`,
  ch4: `CH${SUB_4}`,
  co2: `CO${SUB_2}`,
  co: "CO",
};

export type WaveWindow = readonly [min: number, max: number];

export interface MoleculeBand {
  readonly molecule: MoleculeId;
  /** Limites de la banda, um. */
  readonly min: number;
  readonly max: number;
  /** Ventanas de continuo a cada lado de la banda, um. Sin ellas la banda no entra en la huella. */
  readonly continuum?: { readonly left?: WaveWindow; readonly right?: WaveWindow };
}

export const MOLECULE_BANDS: readonly MoleculeBand[] = [
  { molecule: "h2o", min: 1.34, max: 1.48, continuum: { left: [1.24, 1.31], right: [1.52, 1.6] } },
  { molecule: "ch4", min: 1.63, max: 1.74, continuum: { left: [1.52, 1.61], right: [2.04, 2.14] } },
  { molecule: "h2o", min: 1.8, max: 1.98, continuum: { left: [1.52, 1.61], right: [2.04, 2.14] } },
  { molecule: "ch4", min: 2.2, max: 2.4, continuum: { left: [2.04, 2.14] } },
  { molecule: "h2o", min: 2.55, max: 3.1 },
  { molecule: "ch4", min: 3.15, max: 3.5, continuum: { left: [2.95, 3.1], right: [3.7, 3.9] } },
  { molecule: "co2", min: 4.2, max: 4.32, continuum: { left: [4.02, 4.15], right: [4.36, 4.46] } },
  { molecule: "co", min: 4.5, max: 4.8, continuum: { left: [3.95, 4.15], right: [4.88, 5.02] } },
];

/** Centro de una banda, um. */
export function bandCenter(band: MoleculeBand): number {
  return (band.min + band.max) / 2;
}
