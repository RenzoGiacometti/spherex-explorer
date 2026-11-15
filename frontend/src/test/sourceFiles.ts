// Lectura de los archivos del frontend para las guardas (guards.test.ts,
// tokens.test.ts). Las rutas se devuelven relativas a frontend/, con "/".

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Carpeta frontend/. */
export const FRONTEND_DIR = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Raiz del repositorio. */
export const REPO_DIR = resolve(FRONTEND_DIR, "..");

/** Extensiones que se leen como texto. */
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".json",
  ".html",
  ".svg",
  ".md",
  ".yaml",
  ".yml",
]);

/** Carpetas que no se recorren: dependencias, salidas y los datos de muestra de otro equipo. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", "fixtures", "_"]);

export interface SourceFile {
  /** Ruta relativa a frontend/, con "/" como separador. */
  path: string;
  text: string;
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

function read(absolutePath: string): SourceFile {
  return {
    path: toPosix(relative(FRONTEND_DIR, absolutePath)),
    text: readFileSync(absolutePath, "utf8"),
  };
}

function walk(directory: string, files: SourceFile[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(absolutePath, files);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extension(entry.name))) {
      files.push(read(absolutePath));
    }
  }
}

/** Todos los archivos de texto de src/, salvo src/test/fixtures. */
export function listSrcFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  walk(join(FRONTEND_DIR, "src"), files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Archivos de texto de frontend/ que estan fuera de src/: los de la raiz
 * (index.html, configuracion, README), scripts/ y los hooks de .husky/.
 */
export function listProjectFiles(): SourceFile[] {
  const files: SourceFile[] = [];

  for (const entry of readdirSync(FRONTEND_DIR, { withFileTypes: true })) {
    if (entry.isFile() && TEXT_EXTENSIONS.has(extension(entry.name))) {
      // El lockfile lo escribe pnpm y no es codigo del proyecto.
      if (entry.name === "pnpm-lock.yaml") continue;
      files.push(read(join(FRONTEND_DIR, entry.name)));
    }
  }

  const scripts = join(FRONTEND_DIR, "scripts");
  if (existsSync(scripts)) walk(scripts, files);

  const husky = join(FRONTEND_DIR, ".husky");
  if (existsSync(husky)) {
    for (const name of readdirSync(husky)) {
      const absolutePath = join(husky, name);
      // Los hooks no tienen extension.
      if (statSync(absolutePath).isFile()) files.push(read(absolutePath));
    }
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Lee un archivo de la raiz del repositorio, por ejemplo DESIGN.md. */
export function readRepoFile(name: string): string {
  return readFileSync(join(REPO_DIR, name), "utf8");
}

/** Numero de linea (desde 1) de una posicion dentro de un texto. */
export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index && position < text.length; position += 1) {
    if (text.charCodeAt(position) === 10) line += 1;
  }
  return line;
}
