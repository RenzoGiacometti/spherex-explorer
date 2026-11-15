# SPHEREx Explorer

Herramienta web para el desafío SPHEREx de NASA Space Apps 2026. Muestra imágenes de SPHEREx de una zona del cielo a lo largo del tiempo para detectar objetos que se mueven o varían, y extrae su espectro.

## Documentos de referencia

- `SPEC.md`: datos, arquitectura, API, etapas y criterios de terminado. Es la fuente de verdad del alcance. Leerlo antes de cualquier tarea.
- `DESIGN.md`: sistema de diseño (se agrega al terminar los mockups). Hasta que exista, no inventar estética: interfaz mínima y neutra.
- `prompts/`: prompt de arranque de cada etapa.

## Estructura

```
spike/      Etapa 0: scripts de prueba contra IRSA (descartables)
backend/    FastAPI + astropy
frontend/   React + Vite + TypeScript
```

## Reglas de trabajo

- Trabajar una etapa por vez, en el orden de `SPEC.md`. No adelantar funcionalidades de etapas posteriores.
- Lo marcado **[VERIFICAR]** en `SPEC.md` se comprueba contra el servicio real antes de escribir código que dependa de ello. Si un supuesto resulta falso, actualizar `SPEC.md` en el mismo cambio.
- Nunca inventar nombres de tablas, columnas o parámetros de IRSA: consultarlos (TAP_SCHEMA, tutoriales oficiales) y citar la fuente en un comentario.
- Las llamadas a IRSA son lentas y fallan: siempre con timeout, reintentos y caché en disco. Los tests no dependen de la red; usar recortes guardados como fixtures.
- Todos los servicios externos se consultan desde el backend, nunca desde el navegador.
- Respetar a IRSA: máximo 10 descargas en paralelo en total (límite global del backend, no por pedido), reintentos respetando `Retry-After`.
- Listar exposiciones con SIA2. TAP no respondió durante la Etapa 0; ver `spike/RESULTADOS.md`.

## Entorno

- El proyecto vive en Windows (no WSL). Los comandos y scripts deben funcionar en PowerShell; usar rutas con `pathlib`, no separadores fijos.

## Convenciones

- Frontend: pnpm, TypeScript estricto, Biome, Husky, dependencias con versión fija.
- Cero textos de interfaz hardcodeados: todo por i18next (es, en).
- Cero colores hardcodeados: solo tokens semánticos.
- Cero emojis, incluidos dingbats Unicode. Sin violeta ni púrpura en la interfaz.
- Backend: Python 3.12, uv, type hints, ruff.
- Commits: Conventional Commits, asunto de 72 caracteres o menos.

## Objetos de prueba

Barnard's Star, Epsilon Indi B, WISE 0855 (RA 08h55m10.831s, Dec -07d14m42.53s), RW Aurigae, R Draconis. Barnard y WISE 0855 tienen movimiento propio alto, y las coordenadas de catálogo pueden ser de hace más de una década: propagar siempre la posición a la fecha de observación. Aplica a cualquier objeto resuelto por nombre.
