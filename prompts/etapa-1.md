Leé `CLAUDE.md`, `SPEC.md`, `spike/RESULTADOS.md` y, si existe, `DESIGN.md`.

Tarea: Etapa 1 de `SPEC.md` (visor). Trabajá en dos fases y esperá mi aprobación entre una y otra.

## Fase A: contrato y plan (sin código de producto)

1. Corré `spike/field.py` para Epsilon Indi B, RW Aurigae y R Draconis, y agregá los resultados a `spike/RESULTADOS.md`. Interesa sobre todo cuántas exposiciones tiene R Draconis (está cerca del polo eclíptico) y cuánto tarda.
2. Escribí `docs/contrato-cubo.md` con el formato exacto de `/api/field`: eventos SSE, JSON de metadatos, disposición binaria del cubo, manejo de píxeles sin datos y de fuentes saturadas. Tené en cuenta lo que mostró la Etapa 0:
   - Un campo nuevo tarda de 105 a 185 s. El contrato debe permitir entrega progresiva: el frontend muestra cada (época, detector) apenas está listo, sin esperar el cubo completo.
   - Hay que cachear el cubo final, no solo los recortes: un campo ya calculado debe abrir en menos de 2 s.
   - Pedir recortes más grandes que el campo para cubrir las esquinas (orientación del detector).
   - El corte de la conexión antes de EPSF depende del orden de las extensiones: dejar un camino alternativo que baje el archivo completo si el orden cambia.
   - `/api/resolve` propaga la posición por movimiento propio para cualquier objeto que lo tenga.
   - Cola de trabajos con límite global de descargas hacia IRSA.
3. Proponé el plan de la Etapa 1 partido en tareas, indicando cuáles pueden ir en paralelo una vez fijado el contrato.

Detenete acá y mostrame el contrato y el plan.

## Fase B: implementación

Con el contrato aprobado, implementá la Etapa 1. Criterios de terminado:

- Un link con coordenadas abre el visor; los cinco objetos de prueba están precalculados y abren en menos de 2 s.
- Para un campo nuevo, la primera imagen aparece apenas llega y el resto se completa con barra de progreso.
- Parpadeo entre las 3 épocas, selector de detector, escala y contraste, campo de visión, diferencia, suma, rojo/cian y mantener apretado.
- Capa de flags y aviso visible cuando una fuente está saturada.
- Tests del backend sin red, con recortes guardados como fixtures.
