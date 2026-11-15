# SPHEREx Explorer: frontend

React + Vite + TypeScript estricto. Habla con el backend solo por `/api`, según `docs/contrato-cubo.md`. El sistema de diseño está en `DESIGN.md` y el alcance en `SPEC.md`, los dos en la raíz del repositorio.

## Requisitos

- Node 20.18 o posterior. Por eso Vite 6, Vitest 4 y jsdom 26: las versiones siguientes piden Node 20.19 o 22.
- pnpm 12.

## Instalar

```powershell
cd frontend
pnpm install
```

No hace falta nada más: `pnpm-workspace.yaml` ya autoriza los scripts de instalación que se necesitan (esbuild) y fija `saveExact`. La instalación también deja activos los hooks de git (`.husky/`).

Para agregar una dependencia, siempre con versión exacta: `pnpm add <paquete>` o `pnpm add -D <paquete>`.

## Correr

```powershell
pnpm dev
```

Abre `http://localhost:5173`. Todo lo que empieza con `/api` se redirige al backend en `http://127.0.0.1:8000`, incluido el flujo de eventos (SSE), que pasa sin buffer. Para apuntar a otro puerto, por ejemplo el del servidor falso:

```powershell
$env:SPHEREX_API_TARGET = "http://127.0.0.1:8001"; pnpm dev
```

Sin coordenadas en la URL se ve la entrada; con `ra` y `dec`, el visor:

```
/?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink
```

| Parámetro   | Valores                                         | Por defecto                                                |
| ----------- | ----------------------------------------------- | ---------------------------------------------------------- |
| `ra`, `dec` | Centro del campo en grados ICRS                 | sin campo: entrada                                         |
| `fov`       | `0.0833` (5′), `0.1667` (10′) o `0.5` (30′)     | `0.1667`                                                   |
| `band`      | 1 a 6                                           | `3`                                                        |
| `mode`      | `blink`, `difference`, `sum`, `redcyan`, `hold` | `blink`                                                    |
| `epoch`     | Época actual, desde 1                           | sin fijar                                                  |
| `name`      | Nombre del objeto, para la mira y el rastro     | sin nombre                                                 |
| `embed`     | `1` oculta la interfaz alrededor del visor      | apagado                                                    |
| `lang`      | `es` o `en`                                     | idioma del navegador; si no es ninguno de los dos, español |

## Probar

```powershell
pnpm lint        # Biome: formato, imports y reglas
pnpm typecheck   # tsc -b
pnpm test        # Vitest
pnpm build       # tsc -b y vite build, deja el sitio en dist/
pnpm format      # aplica el formato de Biome
pnpm preview     # sirve dist/ con el mismo proxy de /api
```

Los tests no usan la red. Además de los tests de cada módulo hay guardas que recorren el código:

- `src/test/guards.test.ts`: ningún color literal fuera de `src/styles/tokens.css`, ningún emoji ni dingbat, ningún violeta ni púrpura, y ningún texto de interfaz escrito a mano en los componentes.
- `src/test/tokens.test.ts`: `tokens.css` dice lo mismo que el front matter de `DESIGN.md`.
- `src/i18n/resources.test.ts`: español e inglés tienen las mismas claves.
- `src/api/fixtures.test.ts`: los datos de muestra de `src/test/fixtures` (campos, trayectorias y la transcripción de eventos SSE de un campo nuevo, generados por el backend) pasan por los esquemas del frontend sin que se pierda ni cambie nada.

## Hooks de git

El `.git` está en la raíz del repositorio y este `package.json` en `frontend/`, así que `pnpm install` corre `scripts/prepare.mjs`, que instala husky desde la raíz apuntando a `frontend/.husky`.

`pre-commit` corre Biome solo sobre los archivos de `frontend/` que están en el índice. No frena un commit por falta de herramientas: si no hay archivos de frontend, si faltan las dependencias o si `node` no está en el PATH, avisa y deja pasar. No necesita pnpm.

## Mapa de carpetas

```
index.html              fuentes IBM Plex (Google Fonts) y punto de entrada
vite.config.ts          alias "@" a src/, proxy de /api y configuración de Vitest
biome.json              formato y reglas
scripts/prepare.mjs     instalación de los hooks de git
.husky/pre-commit       Biome sobre lo que está en el índice
src/
  main.tsx              arranque: estilos, i18n y montaje
  App.tsx               decide entre la entrada y el visor según la URL
  styles/
    tokens.css          tokens de DESIGN.md como variables CSS; único archivo con colores literales
    base.css            fondo negro, tipografía base y clases .type-*
  i18n/                 i18next; locales/<idioma>/<namespace>.json, un namespace por funcionalidad
  api/
    schema.ts           esquemas zod del contrato
    types.ts            tipos inferidos de los esquemas
    client.ts           una función por endpoint; errores como ApiError con code
    sse.ts              suscripción a /events con reconexión
    sseParser.ts        analizador de text/event-stream
    binary.ts           tamaños y vistas de planos, cubo y capas auxiliares
    errors.ts           ApiError y lectura del cuerpo de error
  state/
    urlState.ts         estado en la URL (store de zustand)
  lib/
    format.ts           coordenadas, fechas y números con el formato de DESIGN.md
    wcs.ts              proyección gnomónica: píxel a cielo y cielo a píxel
    fov.ts              vistas de 5′, 10′ y 30′ y el escalón de campo que les corresponde
  features/             una carpeta por funcionalidad; hoy, los marcadores de posición de entrada y visor
  test/                 preparación de Vitest, guardas y ejemplos del contrato
    fixtures/           datos de muestra generados por el backend
```

Todavía no existen y llegan con las tareas siguientes: `src/components/` (primitivas del sistema de diseño), `src/viewer/` (visor WebGL2) y `src/state/fieldStore.ts` (estado del campo).

## Convenciones

- Estilos con CSS Modules (`Componente.module.css`) y variables de `tokens.css`. Ningún color literal fuera de ese archivo; la tipografía se aplica con las clases `.type-*` o con las variables `--type-*`.
- Ningún texto de interfaz en los componentes: todo sale de `src/i18n/locales`, en español e inglés. Un namespace nuevo se registra en `src/i18n/resources.ts`.
- Todo número que ve la persona pasa por `src/lib/format.ts`.
- El JSON del backend entra siempre por los esquemas de `src/api/schema.ts`. Si cambia el contrato, se cambia el esquema y los tipos lo siguen.
- Importaciones internas con el alias `@/`. Exportaciones con nombre, sin `export default` (Biome lo exige).
