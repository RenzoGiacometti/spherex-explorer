# Alas de las fuentes saturadas: dos hallazgos

Salieron el 15 de noviembre de 2026, al construir el medidor de movimiento propio (`frontend/src/features/measure/`). Importan para cualquier cosa que se mida sobre las alas de una estrella saturada en un plano del cubo, sea posición o fotometría.

Se midieron sobre los campos precalculados de Barnard, R Draconis y RW Aurigae (cubo base, 3,075"/px, 3 épocas cada uno). El centro de cada estrella se obtuvo ajustando un perfil de Moffat a las alas (`wingsFit.ts`). En Barnard se comparó con la posición de catálogo propagada a la fecha de cada plano, con paralaje. R Draconis y RW Aurigae casi no se mueven: se comparó cada una consigo misma entre épocas.

## 1. Alrededor del núcleo hay una franja de cobertura parcial

El núcleo saturado llega al plano como `+Infinity` (contrato, sección 7). Pegada a él hay una franja de píxeles válidos a los que aportó solo una parte de las exposiciones, porque cada exposición enmascaró una zona distinta alrededor de la estrella.

- La franja mide entre 2 y 11 píxeles de la grilla (6" a 34") desde el borde del núcleo, según el plano.
- No es simétrica. En RW Aurigae, B6, época 1 (19 exposiciones), a 1, 2, 3 y 4 px del borde del núcleo la cobertura vale 3, 7, 14 y 18 hacia el este, y 1, 1, 4 y 10 hacia el oeste.
- Sus valores no se pueden comparar con los del resto de las alas, porque promedian otro conjunto de exposiciones. El plano no lo dice: son píxeles finitos como cualquier otro. Solo se ve en la capa de cobertura (`/api/field/{id}/aux/{época}/{detector}`).

Error del centro ajustado, por época y por coordenada. Sale de comparar las épocas 1 y 3, que son de la misma estación:

| | Sin la capa de cobertura | Con la capa |
|---|---|---|
| Barnard | 0,49" | 0,22" |
| R Draconis | 0,60" | 0,26" |
| RW Aurigae (B2 a B6) | 1,06" | 0,21" |
| Las tres | 0,75" | 0,23" |

En una fuente saturada a medias es peor: sin la capa, el centro de RW Aurigae en B6, época 1, queda a 7" de la posición de catálogo.

**Qué se hace.** El ajuste usa solo los píxeles con al menos el 85 % de la cobertura de referencia (la mediana de un anillo entre 7 y 12 px nativos del borde del núcleo), y empieza donde termina la franja. El medidor pide la capa auxiliar cuando el clic cae sobre una fuente saturada.

**Qué queda.** En R Draconis, B1, época 2, el ajuste no da posición ni con la capa. La fotometría sobre las alas (investigación de la Etapa 2) no se probó acá; por lo anterior, conviene que también descarte la franja.

## 2. El centro de las alas va y viene cada seis meses

Con la franja descartada queda un corrimiento sistemático: entre dos pasadas consecutivas (seis meses) el centro ajustado salta, y un año después vuelve a su lugar.

Posición de la época 2 respecto del promedio de las épocas 1 y 3:

| | Salto, según la banda | Hacia dónde, en la época 2 |
|---|---|---|
| Barnard (descontada la paralaje) | 1,5" a 3,5" | este |
| R Draconis (B2 a B6) | 1,2" a 3,3" | sur |
| RW Aurigae (B2 a B6) | 1,3" a 2,8" | oeste |

- En cada estrella el salto tiene el mismo sentido en todas las bandas.
- No es un error de registro entre épocas: las estrellas de campo sin saturar se corren menos de 0,2" (mediana por banda, campo de Barnard).
- No parece depender del modelo. Sin la capa de cobertura, una ley de potencias en logaritmos y un centro de simetría puntual dieron un salto parecido al del perfil de Moffat; con la capa no se repitió la prueba.
- En la Etapa 0 no se notó: el desplazamiento se midió entre las épocas 1 y 3, que son de la misma estación.

**Causa.** No está comprobada. La explicación más probable es que las alas no sean simétricas y que el detector quede girado 180° sobre el cielo seis meses después. Faltaría mirar la orientación de las exposiciones de cada época.

**Qué se hace.** El salto se confunde con la paralaje, que también cambia de signo cada seis meses. Con tres épocas o más, el ajuste del movimiento propio suma un término que alterna con la estación y absorbe las dos cosas (`motion.ts`): el movimiento propio sale de comparar épocas de la misma estación. Así Barnard da entre 9,74 y 10,93 "/año en las seis bandas, con un error de 0,45, contra 10,45 del catálogo calculado de la misma manera.

**Qué queda.** Con solo dos épocas de estaciones opuestas no hay cómo separarlo: Barnard con las épocas 1 y 2 queda entre 2,6 y 7,0 "/año lejos del catálogo. El medidor lo avisa y suma el salto al error (2,5" repartidos en el intervalo).
