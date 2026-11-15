// Instala los hooks de git con husky.
//
// El .git esta en la raiz del repositorio y este package.json en frontend/,
// asi que husky se ejecuta desde la raiz apuntando a frontend/.husky.
// No falla nunca: si no hay repositorio, si husky no esta instalado (instalacion
// de produccion) o si se pide omitirlo con HUSKY=0, avisa y sale con 0.

import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(frontendDir, "..");
const hooksDir = relative(repoRoot, resolve(frontendDir, ".husky")).split("\\").join("/");

function skip(reason) {
  console.log(`husky: no se instalan los hooks (${reason})`);
  process.exit(0);
}

if (process.env.HUSKY === "0") skip("HUSKY=0");
if (process.env.CI) skip("entorno de CI");
if (!existsSync(resolve(repoRoot, ".git"))) skip("no hay .git en la raiz del repositorio");

let husky;
try {
  husky = (await import("husky")).default;
} catch {
  skip("husky no esta instalado");
}

process.chdir(repoRoot);
const message = husky(hooksDir);
if (message) console.log(message.trim());
