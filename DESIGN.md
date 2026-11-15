---
version: alpha
name: SPHEREx-Explorer
description: Sistema de diseño de SkyBlink, una herramienta web pública para explorar imágenes infrarrojas del cielo de la misión SPHEREx de NASA y detectar objetos que se mueven o cambian de brillo. Fondo negro puro, la imagen astronómica como contenido, paneles de vidrio flotantes, un único acento ámbar usado con moderación y tipografía monoespaciada para todo dato numérico. Interfaz en español e inglés.

colors:
  void: "#000000"
  glass: "#08080AB8"
  glass-solid: "#0B0B0D"
  hairline: "#FFFFFF24"
  hairline-strong: "#FFFFFF52"
  divider: "#FFFFFF14"
  text: "#FFFFFF"
  text-mute: "#B4B4BC"
  text-dim: "#8E8E97"
  selected: "#FFFFFF"
  on-selected: "#000000"
  accent: "#FFB020"
  on-accent: "#000000"

typography:
  display:
    fontFamily: "IBM Plex Sans Condensed, Arial Narrow, Arial, sans-serif"
    fontSize: 44px
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: 1.2px
    textTransform: uppercase
  display-sm:
    fontFamily: "IBM Plex Sans Condensed, Arial Narrow, Arial, sans-serif"
    fontSize: 30px
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: 0.9px
    textTransform: uppercase
  title:
    fontFamily: "IBM Plex Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0
  body:
    fontFamily: "IBM Plex Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0
  body-sm:
    fontFamily: "IBM Plex Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0
  button-cap:
    fontFamily: "IBM Plex Sans Condensed, Arial Narrow, Arial, sans-serif"
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: 1.2px
    textTransform: uppercase
  label-cap:
    fontFamily: "IBM Plex Sans Condensed, Arial Narrow, Arial, sans-serif"
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 1.2px
    textTransform: uppercase
  data:
    fontFamily: "IBM Plex Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
    fontVariantNumeric: tabular-nums
  data-sm:
    fontFamily: "IBM Plex Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
    fontVariantNumeric: tabular-nums
  data-lg:
    fontFamily: "IBM Plex Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
    fontVariantNumeric: tabular-nums

rounded:
  xs: 4px
  sm: 8px
  pill: 32px
  full: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  huge: 48px

effects:
  glass-blur: 20px
  icon-stroke: 1.5px

components:
  glass-panel:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: 14px
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.button-cap}"
    rounded: "{rounded.pill}"
    padding: 0px 20px
    height: 44px
  button-ghost:
    backgroundColor: "{colors.void}"
    textColor: "{colors.text}"
    typography: "{typography.button-cap}"
    rounded: "{rounded.pill}"
    padding: 0px 20px
    height: 44px
  button-icon:
    backgroundColor: "{colors.void}"
    textColor: "{colors.text}"
    rounded: "{rounded.full}"
    size: 44px
  option:
    backgroundColor: "{colors.void}"
    textColor: "{colors.text}"
    typography: "{typography.label-cap}"
    rounded: "{rounded.xs}"
    padding: 0px 8px
    height: 36px
  option-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.on-selected}"
    typography: "{typography.label-cap}"
    rounded: "{rounded.xs}"
    padding: 0px 8px
    height: 36px
  search-field:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: 0px 16px
    height: 56px
  quick-link:
    backgroundColor: "{colors.void}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.pill}"
    padding: 0px 14px
    height: 36px
  data-row:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.text}"
    typography: "{typography.data}"
    rounded: "{rounded.xs}"
    padding: 6px 0px
  timeline-epoch:
    backgroundColor: "{colors.text}"
    textColor: "{colors.text-dim}"
    typography: "{typography.data-sm}"
    rounded: "{rounded.full}"
    size: 8px
  timeline-epoch-current:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.text}"
    typography: "{typography.data-sm}"
    rounded: "{rounded.full}"
    size: 12px
  timeline-epoch-provisional:
    backgroundColor: "{colors.void}"
    textColor: "{colors.text-dim}"
    typography: "{typography.data-sm}"
    rounded: "{rounded.full}"
    size: 8px
  image-tag:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.text}"
    typography: "{typography.label-cap}"
    rounded: "{rounded.pill}"
    padding: 0px 12px
    height: 28px
  progress-bar:
    backgroundColor: "{colors.hairline-strong}"
    textColor: "{colors.accent}"
    typography: "{typography.data-sm}"
    rounded: "{rounded.xs}"
    height: 2px
  reticle:
    backgroundColor: "{colors.void}"
    textColor: "{colors.accent}"
    typography: "{typography.label-cap}"
    rounded: "{rounded.full}"
    size: 64px
---

## Overview

SkyBlink muestra el cielo infrarrojo y deja que cualquiera, con o sin formación en astronomía, busque objetos que se mueven o cambian de brillo. El sistema parte de una idea: la imagen astronómica es el contenido y la interfaz no compite con ella. El lienzo es negro puro, los controles flotan sobre la imagen en paneles de vidrio semitransparente, y todo lo que no sea imagen se resuelve en blanco, grises y un único acento.

Hereda de su referencia de partida la austeridad del negro y blanco, las etiquetas en mayúsculas con tracking abierto, el botón de píldora con contorno y las líneas finas en lugar de sombras. Se aparta de ella en cinco puntos deliberados: usa otra familia tipográfica (IBM Plex), agrega un acento ámbar, agrega una voz monoespaciada para los datos, reemplaza la navegación y las bandas opacas por paneles flotantes con desenfoque, y admite un juego de iconos de línea.

**Características clave:**
- Lienzo único: `{colors.void}` (`#000000`). No hay tema claro.
- La imagen del cielo ocupa todo el espacio disponible; los paneles se apoyan sobre ella.
- Un solo acento, `{colors.accent}`, con cuatro usos permitidos y ninguno más.
- La opción seleccionada es blanco sólido con texto negro, no acento.
- Coordenadas, fechas, longitudes de onda y cualquier valor numérico van en `{typography.data}`.
- Sin emojis. Iconos de línea de 1,5 px.
- Sin sombras ni degradados decorativos.

## Colors

### Superficie
- **Void** (`{colors.void}`, `#000000`): fondo de toda la aplicación y de las zonas sin datos de una imagen.
- **Glass** (`{colors.glass}`, negro 8/8/10 al 72 %): relleno de los paneles flotantes, siempre con `backdrop-filter: blur(20px)`.
- **Glass Solid** (`{colors.glass-solid}`, `#0B0B0D`): reemplazo del vidrio donde el desenfoque no está disponible.
- **Hairline** (`{colors.hairline}`, blanco al 14 %): borde de 1 px de los paneles.
- **Hairline Strong** (`{colors.hairline-strong}`, blanco al 32 %): borde de opciones y botones de icono, línea base de la línea de tiempo, riel de la barra de progreso.
- **Divider** (`{colors.divider}`, blanco al 8 %): separador entre filas dentro de un panel.

### Texto
- **Text** (`{colors.text}`, `#FFFFFF`): texto principal y valores.
- **Text Mute** (`{colors.text-mute}`, `#B4B4BC`): etiquetas de fila, texto de apoyo, encabezados de panel.
- **Text Dim** (`{colors.text-dim}`, `#8E8E97`): unidades, marcas de eje, texto de ejemplo. Es el gris más oscuro permitido para texto (contraste aproximado de 6:1 sobre negro).

### Selección
- **Selected / On Selected** (`#FFFFFF` / `#000000`): la opción activa de cualquier selector (capa, banda, modo, velocidad, idioma) se invierte a blanco sólido con texto negro.

### Acento
- **Accent, ámbar señal** (`{colors.accent}`, `#FFB020`): el único color de la interfaz. Se reserva para:
  1. La mira sobre el objeto seleccionado y los marcadores de objetos destacados en el cielo.
  2. La época actual en la línea de tiempo.
  3. El avance de la barra de progreso.
  4. La acción principal de la vista, como máximo un botón relleno por pantalla.
- El cursor de lectura del gráfico de espectro cuenta como mira (uso 1).

No hay colores semánticos. Los avisos de calidad se comunican con el icono `alert` y texto. Las moléculas del espectro se distinguen por su etiqueta, no por tono. El modo rojo/cian colorea la imagen, no la interfaz.

## Typography

### Familias
- **IBM Plex Sans Condensed** (600): titulares, etiquetas y botones en mayúsculas.
- **IBM Plex Sans** (400, 500, 600): nombres de objetos, texto corrido, etiquetas de fila.
- **IBM Plex Mono** (400, 500): todo dato.

Las tres se cargan desde Google Fonts. Sustitutos: Arial Narrow, Helvetica Neue o Arial, y la monoespaciada del sistema.

### Jerarquía

| Token | Tamaño | Peso | Interlínea | Tracking | Uso |
|---|---|---|---|---|---|
| `{typography.display}` | 44px | 600 | 1.05 | 1.2px | Titular de página (hoy sin uso: la entrada es la esfera y no lleva titular) (mayúsculas) |
| `{typography.display-sm}` | 30px | 600 | 1.08 | 0.9px | Titular dentro de un panel (mayúsculas) |
| `{typography.title}` | 20px | 600 | 1.2 | 0 | Nombre de objeto; 16 a 26 px según contexto |
| `{typography.body}` | 14px | 400 | 1.45 | 0 | Texto de apoyo |
| `{typography.body-sm}` | 13px | 400 | 1.45 | 0 | Etiquetas de fila, avisos |
| `{typography.button-cap}` | 13px | 600 | 1 | 1.2px | Botones (mayúsculas) |
| `{typography.label-cap}` | 11px | 600 | 1.3 | 1.2px | Encabezados de panel, opciones, estados (mayúsculas) |
| `{typography.data}` | 13px | 400 | 1.4 | 0 | Coordenadas, fechas, valores |
| `{typography.data-sm}` | 11px | 400 | 1.4 | 0 | Ejes, rangos de banda, marcas de la línea de tiempo |
| `{typography.data-lg}` | 20px | 400 | 1.4 | 0 | Cifra destacada en la ficha del objeto |

### Principios
- **Los nombres propios no van en mayúsculas.** Los objetos (Barnard's Star, Epsilon Indi B) se escriben como en el catálogo, en `{typography.title}`. Las mayúsculas quedan para titulares y etiquetas.
- **Todo número es mono.** Si un valor se puede copiar a un catálogo o comparar con otro, va en `{typography.data}` con cifras tabulares. La unidad acompaña al valor en la misma familia.
- **Formato de datos.** Ascensión recta `22h 04m 10s`, declinación `−56° 46′ 58″` con signo menos tipográfico y primas reales, fecha ISO `2025-12-03`, hora en UTC. En español el separador decimal es la coma (`0,75 µm`); en inglés, el punto (`0.75 µm`).
- **Dos idiomas.** Los textos en español ocupan cerca de un 20 % más que en inglés: ningún control fija su ancho al texto y las etiquetas no se cortan con puntos suspensivos, salvo nombres largos dentro de una fila.

## Layout

### Espaciado
- **Unidad base**: 4px. Tokens: `{spacing.xxs}` 4 · `{spacing.xs}` 8 · `{spacing.sm}` 12 · `{spacing.md}` 16 · `{spacing.lg}` 24 · `{spacing.xl}` 32 · `{spacing.huge}` 48.
- Margen entre un panel y el borde de la ventana: 24px en escritorio, 12px en celular.
- Separación entre paneles apilados: 12px. Relleno interno de panel: 14px (compacto) a 24px (panel de espectro).

### Estructura
- No hay barras laterales ni cabeceras opacas. La barra superior es transparente: marca a la izquierda, idioma a la derecha.
- La imagen define el espacio. En la entrada, la esfera celeste llena la ventana. En el visor, el recorte cuadrado toma toda la altura disponible y los paneles se anclan a las esquinas y bordes.
- Cada panel agrupa una sola tarea (banda, modo, imagen, metadatos, avisos, tiempo) y lleva un encabezado con icono y `{typography.label-cap}`.
- El centro de la imagen queda libre: ningún panel tapa la mira.
- **Entrada.** La entrada es la esfera celeste a ventana completa, sin titular ni bajada: la marca arriba a la izquierda, el idioma arriba a la derecha y, abajo al centro, el buscador con el botón "Lugar al azar" a su lado y un renglón de ayuda. El centro del cielo que se mira y el crédito de la textura van al pie, en `{typography.data-sm}` y `{typography.body-sm}`. Sin WebGL la esfera se reemplaza por un aviso; el buscador, "Lugar al azar" y los accesos siguen en su lugar.
- **Objetos del desafío.** Los cinco objetos del desafío van siempre a la vista como `quick-link`, en un renglón encima de los tres accesos de la entrada. En celular es un solo renglón que se desliza hacia el costado, con el cuarto cortado para que se note que sigue. Cada marcador de la esfera muestra el nombre de su objeto mientras está en pantalla.
- **Accesos de la entrada.** Encima del buscador, tres `button-ghost` en una sola línea en escritorio, con rótulos cortos: "Recorrido guiado" (icono `target`), "Viaje en el tiempo" (abre Wolf 359 en el viaje entre misiones) y "Visible e infrarrojo" (abre M 51 con la cortina). El detalle de cada uno va en su descripción. En celular se apilan a todo el ancho; en un celular bajo (menos de 760px de alto) van en un renglón que se desliza hacia el costado, para que quede cielo donde tocar.
- **Punto elegido.** Un clic o un toque corto sobre la esfera deja una mira en `{colors.accent}` y abre una tarjeta de vidrio sobre los accesos: el rótulo `PUNTO ELEGIDO` en `{typography.label-cap}`, las coordenadas en mono, la constelación, un renglón que dice si es un campo guardado ("abre al instante") o uno nuevo ("armarlo tarda unos minutos"), el `button-ghost` "Abrir este campo" y un `button-icon` para quitar la mira. En escritorio es una franja baja (unos 100px) con los botones a la derecha. En celular ocupa, mientras está abierta, el lugar de los cinco objetos y de los accesos; el buscador y el botón de cerrar siguen a la vista. Si la tarjeta taparía la mira, el cielo sube solo con un vuelo corto.
- **Constelaciones.** `button-icon` con el icono `layers` en la barra superior de la entrada, a la izquierda de "Acerca de"; prendida va relleno en blanco. Dibuja las figuras con líneas de 1px en `{colors.text-dim}` y los nombres en `{typography.body-sm}` `{colors.text-mute}`, en el idioma de la interfaz. Los nombres ceden el lugar: no se escribe el que toca el rótulo de un marcador, la mira o cualquier panel. Las líneas son fondo y pasan por debajo de todo.
- **Marcadores y paneles.** Un marcador cuyo anillo cae debajo de un panel, del crédito o de la barra no se dibuja; si solo cae su nombre, queda el anillo. Un clic sobre el nombre de un marcador abre su objeto, igual que el anillo.
- **Acerca de.** `button-ghost` chico en la barra superior de la entrada, junto al idioma (en celular, solo el icono `info`, para que el idioma entre en la barra). Abre un diálogo modal de vidrio con el título en `{typography.display-sm}` y cuatro bloques: qué es, la declaración de uso de IA en un recuadro con borde `{colors.hairline-strong}`, los créditos de datos con su licencia (uno por renglón, separados por `{colors.divider}`) y la aclaración sobre el sonido. Solo texto: no lleva logos.
- **Recorrido guiado.** En el visor, el recorrido es una tarjeta de vidrio de 320px con el número de paso en mono (`3 / 6`), una consigna corta y, si hace falta, un botón; un anillo en `{colors.accent}` rodea el control que hay que usar. La tarjeta no tapa la mira ni el control señalado; en el último paso va a la izquierda del panel de espectro.
- **Barra superior del visor.** Sus dos extremos van sobre vidrio (a la izquierda: salida, marca, nombre del objeto y coordenadas; a la derecha: idioma). El centro de la barra sigue transparente. Sin el vidrio, las coordenadas en `{colors.text-mute}` no se leían sobre el gris medio del modo diferencia.
- **Zona libre del visor.** La imagen se encuadra en la zona que dejan libre la barra, las dos columnas y el muelle de abajo, no en la ventana entera; al acercar, la imagen sigue por debajo de los paneles hasta los bordes de la ventana. Con el panel de espectro abierto la columna derecha se ensancha y la imagen se reencuadra en lo que queda.
- **Marca.** `SkyBlink` en IBM Plex Sans Condensed 600 de 15px con tracking de 2,4px, igual en la entrada y en el visor.

## Elevation & Depth

| Nivel | Tratamiento | Uso |
|---|---|---|
| 0 | Imagen o negro puro | Cielo, recorte del campo |
| 1 | Anotación directa sobre la imagen, sin fondo | Mira, rastro de épocas, escala, rosa N/E, etiqueta de banda |
| 2 | Vidrio: `{colors.glass}` + desenfoque de 20px + borde `{colors.hairline}` | Paneles, muelles, campos de búsqueda, hojas inferiores |

No se usan sombras. La separación entre niveles la dan el desenfoque y la línea fina. Único degradado admitido: el sombreado del limbo en la vista de globo de la entrada, porque describe la esfera.

## Shapes

| Token | Valor | Uso |
|---|---|---|
| `{rounded.xs}` | 4px | Opciones de selector, campos dentro de un panel, botones de herramienta |
| `{rounded.sm}` | 8px | Paneles de vidrio |
| `{rounded.pill}` | 32px | Botones con texto, accesos rápidos, indicadores flotantes |
| `{rounded.full}` | 9999px | Botones de transporte, marcas de época, marcadores |

Las imágenes del cielo nunca llevan esquinas redondeadas ni marco, salvo una línea `{colors.hairline-strong}` cuando el recorte se muestra sobre un fondo de contexto.

### Iconos
Línea de `{effects.icon-stroke}` sobre una grilla de 24, extremos y uniones redondeados, sin relleno, en el color del texto. Tamaños de uso: 18px en encabezados de panel, 20 a 24px en botones. Conjunto actual: search, shuffle, layers, play, pause, prev, next, target, share, flag, sound, info, alert, close, plus, minus, contrast, globe, back, bands, blink, fov, compass, spectrum. Todo botón que muestre solo un icono lleva etiqueta accesible.

## Components

### Botones
- **`button-primary`**: relleno `{colors.accent}`, texto negro, píldora de 44px. Uno por vista como máximo (Buscar, Reportar candidato, Abrir en el visor).
- **`button-ghost`**: transparente, borde blanco de 1px, texto blanco, píldora de 44px. Acciones secundarias (Lugar al azar, Escuchar, Compartir).
- **`button-icon`**: círculo de 44px con borde `{colors.hairline-strong}`. Seleccionado o de reproducción: relleno blanco con icono negro. Las herramientas en riel usan radio `{rounded.xs}`.

### Selectores
- **`option` / `option-selected`**: celdas de 36px (44px en celular) en grilla con 4px de separación. Sirven para capa, modo, velocidad, campo de visión e idioma. El campo de visión ofrece 5′, 10′ y 30′.
- **Selector de banda**: variante de `option` a dos líneas, con el nombre (`B3`) en `{typography.label-cap}` y el rango (`1,63–2,43`) en `{typography.data-sm}`. Las seis bandas de SPHEREx, con los rangos que informa el archivo de datos: B1 0,75–1,12 · B2 1,10–1,65 · B3 1,63–2,43 · B4 2,40–3,85 · B5 3,81–4,43 · B6 4,41–5,01 µm. La interfaz toma el rango de los metadatos del campo, no de una lista fija. Una banda sin datos en la época actual se muestra en `{colors.text-dim}` y sigue siendo elegible.
- **Deslizador**: control nativo de rango en blanco, con etiqueta a la izquierda y valor en mono a la derecha.
- **Conmutador**: pista de 36 × 20px con borde `{colors.hairline-strong}` y perilla blanca de 12px. Prendido: pista en blanco sólido con perilla negra. Sirve para prender y apagar una capa (flags).
- **Foco y deshabilitado**: el foco de teclado es un contorno blanco de 2px separado 2px del control; el acento no se usa para el foco. En el visor el anillo se dibuja encima de la imagen, hacia adentro, porque un contorno del contenedor queda tapado por ella. Un control deshabilitado va al 40 % de opacidad.

### Paneles y datos
- **`glass-panel`**: contenedor de todo control que flota sobre la imagen. Encabezado con icono de 18px y `{typography.label-cap}`.
- **`data-row`**: etiqueta en `{typography.body-sm}` `{colors.text-mute}` a la izquierda, valor en `{typography.data}` a la derecha, separador `{colors.divider}`.
- **Aviso de calidad**: icono `alert` en blanco y una frase en `{typography.body-sm}`. El encabezado del panel muestra la cantidad en mono. Son avisos, entre otros: una fuente saturada en el campo, una época armada con pocas exposiciones, y una comparación (diferencia, suma, rojo/cian, mantener apretado) en la que alguna de las épocas es provisoria.
- **Aviso en un renglón**: los avisos destacados del panel del espectro y de la curva de luz, y el de fuente saturada sin gráfico, ocupan un solo renglón cortado con puntos suspensivos y un botón de texto "Ver más" / "Ver menos". El botón aparece solo si la frase no entra.
- **Ficha del objeto plegada**: al elegir un punto, la ficha muestra un resumen de uno o dos renglones (identificador de Gaia, distancia y movimiento por año, o "Gaia no tiene ninguna fuente en este punto") y un botón de texto "Ver ficha" / "Ocultar". Empieza cerrada y se vuelve a cerrar con cada punto nuevo.
- **El gráfico primero**: lo primero que se ve tras un clic es el gráfico, entero y sin desplazar, en 1366×768 y en celular. Para eso, con el panel abierto la columna derecha baja hasta el borde de la ventana, al costado del muelle; en celular la hoja sube al 62 % del alto, el panel pierde su encabezado y el gráfico mide 216px. En la curva de luz los selectores de banda y de medición van debajo del gráfico.
- **Rótulos de moléculas**: en dos renglones sobre el gráfico del espectro. El que chocaría en los dos no se rotula (su franja se dibuja igual), y el renglón de arriba no pisa el título del eje.
- **`search-field`**: campo de vidrio de 56px con icono, etiqueta visible encima y ejemplo de nombre y coordenadas como texto de ayuda. Los renglones de ayuda que quedan fuera del vidrio, directamente sobre la imagen, van en `{colors.text-mute}`: `{colors.text-dim}` no llega a 4,5:1 sobre un recorte real.
- **`quick-link`**: píldora de 36px para los objetos destacados.
- **Foco del buscador**: el anillo de foco (2px blanco separado 2px) rodea el campo entero cuando el cursor está en el texto, y el borde pasa a blanco.
- **Ejemplo del buscador**: nombre y coordenadas en grados decimales con punto (`Barnard's Star · 269.4463 +4.7683`), en cualquier idioma: son los mismos decimales del centro del campo, así quien copia el ejemplo abre el campo precalculado.
- **Mensajes del buscador**: debajo del campo, en un renglón reservado para que el campo no se mueva. Mientras resuelve: `Buscando…`. Si falla: el texto del error y una frase que dice qué probar. Cuando el servicio de nombres no responde va un texto propio que invita a buscar por coordenadas. Buscar con el campo vacío avisa "Hay que escribir un nombre o unas coordenadas." y devuelve el foco al campo. Unas coordenadas fuera de rango dicen los rangos válidos de ascensión recta y declinación, sin mencionar el campo de visión.
- **Controles del panel Imagen**: contraste (deslizador), capa de flags (conmutador), estirado (`option` de tres celdas: lineal, log, asinh) y campo de visión (`option`). El panel Modo suma, en los modos que comparan, la época de referencia como `option` con el número y el mes de cada época, y en "mantener apretado" un `button-ghost` que muestra la referencia mientras se lo aprieta.
- **Error del campo**: `glass-panel` con `role=alert`, centrado si no hay imagen y abajo de la zona libre si la hay. Su botón Reintentar es el único `button-primary` del visor y queda deshabilitado mientras dura la espera que pidió el servidor. Debajo ofrece dos salidas como `button-ghost`, para que un campo que no se pudo armar no sea un callejón: "Abrir {nombre}", con el campo guardado más cercano y un renglón que dice a qué distancia está y que los guardados abren sin esperar al archivo de datos, y "Abrir el recorrido guiado".
- **Modos**: el panel Modo tiene siete celdas `option`: parpadeo, diferencia, suma, rojo/cian, mantener apretado, viaje entre misiones y cortina. Debajo va una línea en `{typography.body-sm}` `{colors.text-mute}` que dice qué hace el modo elegido.
- **Control deshabilitado**: queda a la vista al 40 % de opacidad y dice por qué. El motivo aparece en una ayuda flotante de vidrio (`{typography.body-sm}`) al pasar el cursor, al tocarlo o al enfocarlo, y es además su descripción accesible. Para eso el control usa `aria-disabled` en lugar de `disabled`: sigue recibiendo el foco y el toque, pero no ejecuta nada. Ejemplos: la cortina en un campo nuevo ("Disponible solo en los campos guardados: este campo no tiene placa en luz visible"), la época de referencia igual a la actual, Reproducir fuera del modo parpadeo.
- **Capa de Gaia**: conmutador en el panel Imagen, debajo del de la capa de flags; prendida muestra el largo de las flechas (de 1 a 10 000 años de movimiento, de a saltos) y la magnitud límite. Las flechas se recortan al rectángulo de la imagen: ninguna pasa sobre los paneles ni sobre el fondo.
- **Flags**: la lista de flags muestra la descripción de cada uno en el idioma de la interfaz (los 23 nombres del archivo tienen texto en español; un nombre desconocido cae a la descripción original).
- **Celular, alto de la imagen**: la imagen conserva su alto al pasar a diferencia, rojo/cian o mantener apretado; lo que se desplaza es la zona de controles (`data-stage-lock` en `main`). Vale también para un link abierto directamente en uno de esos modos: el alto sale de lo que ocuparían los controles en parpadeo, no de haber pasado por él. El botón "Curva de luz de ..." va con los controles, debajo de la imagen, y no flota sobre ella.
- **Herramienta Medir**: `glass-panel` "Medir movimiento" en la columna derecha, entre el panel de espectro y Metadatos. Apagada muestra solo el conmutador "Medir" y un renglón que dice para qué sirve; prendida, el panel completo: las marcas por época, el movimiento propio con su error en `{typography.data-lg}` y la comparación con el catálogo. En celular es una tira con el conmutador arriba de los controles de modo y, prendida, el panel ocupa ese lugar con un alto máximo del 30 % de la pantalla. Sus avisos (dos marcas de estaciones opuestas; fuente vecina a menos de 12″) van arriba, en el mismo recuadro destacado del espectro. Con Medir prendida el cursor sobre la imagen es una cruz.

### Tiempo y carga
- **Línea de tiempo**: línea base `{colors.hairline-strong}` con una marca por época. Cada época es una pasada del relevamiento, y un campo tiene 3 o 4; las marcas se ubican según su fecha. Cinco estados: cargada (`timeline-epoch`, punto blanco de 8px), provisoria (`timeline-epoch-provisional`, anillo punteado de 8px: la imagen se armó con parte de sus exposiciones), sin cargar (punto hueco de 8px), sin datos (cruz de 8px en `{colors.text-dim}`: la época no tiene exposiciones en la banda actual, como la época 4 de Epsilon Indi B en B1 y B4; se puede elegir igual, como una banda sin datos) y actual (`timeline-epoch-current`, punto ámbar de 12px con anillo). Dos marcas nunca quedan a menos del ancho de una parada (56px), aunque sus fechas sean cercanas. Debajo, el mes de inicio de cada época en `{typography.data-sm}`. La época actual conserva el ámbar aunque sea provisoria; lo provisorio se lee en el rótulo de la imagen.
- **Transporte**: anterior, reproducir (blanco sólido, 44px en escritorio y 56px en celular; hasta 64px) y siguiente.
- **`progress-bar`**: línea de 2px, avance en `{colors.accent}`, con etiqueta en mayúsculas a la izquierda y conteo en mono a la derecha (`14 / 22 recortes · 64 %`). Mientras el avance no se conoce (en cola, listando exposiciones) un tramo ámbar recorre el riel; con `prefers-reduced-motion` queda quieto.
- **Estado de la carga**: ocupa siempre un renglón al pie del muelle, para que la imagen no cambie de tamaño al terminar: la `progress-bar` mientras carga y, al final, `CAMPO COMPLETO · 358 recortes` o `CAMPO INCOMPLETO · faltaron 4 de 258 recortes`. Debajo de "Campo incompleto" va un `button-ghost` "Completar el campo", que lo vuelve a pedir sin sacar de la vista lo que ya cargó; si el pedido falla, un aviso de calidad dice el motivo.
- **Campo nuevo**: mientras no llega la primera imagen, el centro de la zona libre dice en `{typography.body}` `{colors.text-mute}` que el campo se está armando con imágenes de IRSA y que tarda unos minutos. Aparece con 0,4 s de demora para no parpadear al abrir un campo ya calculado.
- **Archivo de datos lento**: cuando el listado de exposiciones va por su segundo intento o más, la `progress-bar` cambia su etiqueta a `ARCHIVO DE DATOS LENTO` con `Intento 3` en mono a la derecha, y aparece la frase "El archivo de datos (IRSA) está respondiendo lento. SkyBlink sigue intentando: puede tardar unos minutos.": en el centro de la zona libre si todavía no hay imagen, o en un recuadro de vidrio abajo si ya se ve la vista provisoria de WISE, que sigue a la vista. No es un error: lleva `role=status`, no `role=alert`, y no tiene botón.
- **Viaje entre misiones**: en ese modo su control ocupa el muelle de abajo en lugar de la línea de tiempo. Año en `{typography.data-lg}` a la izquierda; a su lado tres `data-row` (misión, banda, fecha de observación); debajo, una línea con una marca por imagen ubicada según su fecha y agrupada por misión (2MASS, WISE, SPHEREx), y el transporte centrado. La imagen del cuadro se dibuja en el mismo visor.

### Sobre la imagen
- **`reticle`**: círculo con cuatro marcas en `{colors.accent}`, de 64px en el visor y 128px en la ventana al cielo. A su derecha, el nombre en `{typography.label-cap}` y el movimiento propio en mono.
- **Rastro**: anillos blancos de 8px con opacidad creciente que marcan la posición del objeto en épocas anteriores.
- **Escala y orientación**: barra de escala con su valor en mono abajo a la izquierda; rosa N/E arriba a la derecha.
- **Marcador de destacado**: anillo ámbar de 12px con el nombre en mono.
- **Rótulo de imagen** (`image-tag`): píldora de vidrio de 28px centrada sobre el borde superior de la imagen, con una palabra en `{typography.label-cap}` y el dato en mono. Tiene dos usos. Plano provisorio: `PROVISORIO · 9 / 18 exposiciones`. Vista de otro relevamiento mientras carga un campo nuevo: `VISTA PROVISORIA · WISE 3,4 µm`, con una segunda línea en `{typography.body-sm}` que aclara que no es una imagen de SPHEREx. La segunda línea va debajo de la píldora, en su propio vidrio.
- **Fuente saturada**: los píxeles saturados se dibujan en el blanco máximo de la escala, rodeados por un contorno circular de 1px en `{colors.text}` montado sobre un trazo de 3px en `{colors.void}`. El trazo negro de abajo hace que el contorno se lea también sobre el blanco de la propia estrella: una línea sola en `{colors.hairline-strong}` no cambiaba ningún píxel sobre el núcleo de Barnard. En los modos diferencia y rojo/cian esos píxeles se enmascaran (negro, como las zonas sin datos) y el contorno se mantiene. Siempre va acompañada de un aviso de calidad.
- **Capa de flags**: los píxeles marcados se cubren con una trama diagonal de 1px que alterna `{colors.text}` y `{colors.void}`, así se distingue sobre cielo oscuro y sobre una estrella. No usa el acento ni un color propio. Se prende con un conmutador y va acompañada de la lista de flags presentes, con su nombre y la cantidad de píxeles.
- **Punto del espectro**: anillo blanco de 1px montado sobre un trazo en `{colors.void}`, como el rastro, con el radio de la apertura y un mínimo de 7px. Marca el punto medido: si el clic se ajustó a una fuente guardada, el anillo va sobre esa fuente y no sobre el clic. No usa el acento; sobre el objeto con nombre no se dibuja, porque ya tiene su mira.
- **Crédito de la placa**: cada vez que se muestra una placa del Digitized Sky Survey, en el viaje o en la cortina, debajo de la imagen va su crédito en `{typography.body-sm}`: relevamiento, número de placa y titular (`Digitized Sky Survey, placa E722 (POSSI-E). © STScI/AURA`). En el viaje va en un pie de vidrio y la imagen se encuadra arriba de él; ahí mismo se avisa si el objeto estaba fuera del campo en esa fecha ("En 1950, Barnard's Star estaba fuera de este campo: a 13′ hacia el sur").
- **Cortina**: dos imágenes del mismo campo, una sobre otra, separadas por un divisor vertical de 1px blanco con un asa circular de 36px en `{colors.void}`. A la izquierda la luz visible (placa del DSS) y a la derecha el infrarrojo (SPHEREx en la banda y la época elegidas), cada lado con su `image-tag` (`LUZ VISIBLE · DSS · R · 0,65 µm · 1994-06-03`). Arrastrar o tocar lleva el divisor ahí; con el teclado, las flechas.
- **Imagen de otra misión**: `image-tag` con la misión, la banda y la fecha (`2MASS · Ks · 2,16 µm · 1998-12-28`) y la segunda línea "No es una imagen de SPHEREx". Sobre esas imágenes no se dibuja la mira del objeto.
- **Fuentes de Gaia**: un anillo blanco de 8px por fuente, en la posición que tenía en la fecha de la imagen que se ve, con una flecha de 1px que marca su movimiento propio. No usa el acento.

### Espectro
- **Gráfico**: puntos blancos con barras de error en blanco al 45 %, grilla `{colors.hairline}`, ejes en `{typography.data-sm}`. Eje X de 0,75 a 5 µm. Las bandas de H₂O, CH₄, CO₂ y CO son franjas blancas al 7 % con un trazo superior y la fórmula encima. El cursor de lectura es una línea ámbar con el valor en mono (`λ 3,31 µm · 0,05 ± 0,05`).
- **Sonido**: `button-ghost` "Escuchar el espectro" y, pegada a él, una oración que dice la regla (el gráfico recorrido de la longitud de onda más corta a la más larga; más flujo, más agudo; sin datos, silencio) y que no es el sonido del objeto.
- **Huella química**: una fila por molécula con nombre, fórmula en mono, barra blanca de 6px y una palabra (fuerte, moderada, débil, no detectada). La palabra es obligatoria: la barra sola no alcanza.
- **Ficha del objeto**: tipo, distancia y movimiento propio como `data-row` o como celdas con `{typography.data-lg}`.
- **Panel de espectro en el visor**: se abre con un clic o toque corto sobre la imagen. En escritorio va arriba de la columna derecha, que se ensancha a `clamp(380px, 36vw, 560px)` (`clamp(320px, 40vw, 420px)` por debajo de 1180px); entre 600 y 899px queda debajo de la imagen; en celular es una hoja que sube hasta el 56 % de la pantalla y comparte lugar con el cajón de herramientas. Encabezado con el nombre o "Punto del cielo" / "Fuente guardada del campo", las coordenadas en mono y un `button-icon` de 36px para cerrar; también cierra Escape.
- **Estados del panel**: cargando (`progress-bar` sin avance conocido y una línea que dice qué se está midiendo), error (texto del error y Reintentar si corresponde) y sin espectro guardado: un título, la explicación de que el campo solo guarda el espectro de sus fuentes más brillantes, la distancia a la más cercana y un `button-ghost` "Ver la fuente más cercana". Ese último estado no lleva icono de alerta ni gráfico vacío.
- **Avisos del espectro**: los que cambian cómo se lee el gráfico van arriba, en un recuadro con borde `{colors.hairline-strong}`, icono `alert` y texto en blanco pleno, en este orden: el espectro es de la fuente guardada más cercana (con la distancia; no se muestra si es menor que 1″), fuente saturada, fuente corrida respecto del punto pedido. Los demás (exposiciones descartadas, versión de la tabla de longitudes de onda) quedan debajo del gráfico.
- **Ficha del objeto**: arriba de las pestañas, en el mismo panel. Identificador de Gaia en mono, dos celdas con `{typography.data-lg}` (distancia en años luz, movimiento por año) y frases cortas en `{typography.body-sm}`: cuándo salió la luz, hacia dónde se mueve y cuánto tarda en cruzar el ancho de la Luna. Si Gaia no tiene fuente en ese punto lo dice y explica por qué (un objeto muy frío casi no emite en luz visible).
- **Pestañas del panel**: arriba del panel, una franja de vidrio con dos celdas de 44px, Espectro y Curva de luz, sobre la misma fuente. La elegida usa los tokens de `option-selected` (blanco sólido, texto negro, sin acento). Se recorren con las flechas.
- **Curva de luz**: selector de banda como `option` de seis celdas, brillo relativo contra fecha con una franja por época, puntos blancos por exposición y el promedio de cada tramo con su barra de error. Arriba, en el mismo recuadro de los avisos del espectro, un rótulo en píldora y una frase: `VARIACIÓN RELATIVA` cuando la curva se midió en las alas de una fuente saturada (no da el brillo absoluto), o `SIN CURVA` con el motivo (serie insuficiente, inestable o mezclada con una vecina, o no hay curva guardada para ese punto). "Sin curva" no es un error: no lleva el estilo de alerta.
- **Oferta de la curva de luz**: en los campos de las variables del desafío (R Draconis, RW Aurigae), un `glass-panel` compacto arriba de la columna derecha con el rótulo "Estrella variable" y un `button-ghost` con el icono `blink`; en celular, un botón sobre la imagen. Se oculta mientras el panel está abierto.

## Responsive Behavior

| Nombre | Ancho | Cambios |
|---|---|---|
| Escritorio | ≥ 1180px | Paneles anclados a esquinas y bordes; recorte cuadrado a toda la altura |
| Celular | < 600px | Columna única; controles en la mitad inferior; paneles a 12px del borde |
| Intermedio | 900 a 1179px | Columnas de 264px y márgenes de 12px |
| Tableta | 600 a 899px | Columna única que se desplaza: imagen, línea de tiempo y paneles; el espectro, debajo de la imagen |

- **Zona del pulgar.** En celular, todo control frecuente (reproducción, épocas, banda, modo) queda en el 45 % inferior de la pantalla. La parte superior solo muestra información y la salida.
- **Objetivos táctiles** de 44px como mínimo, de alto y de ancho; el botón de reproducción mide 56 a 64px.
- **Lo que cambia de lugar en celular.** El ejemplo del buscador va en un renglón debajo del campo, porque adentro no entra (315px de texto en 203px de campo a 390px de ancho). El riel de la barra de progreso va en su propio renglón, debajo de la etiqueta y el conteo. El texto del buscador sube a 16px, para que Safari de iOS no acerque la página al enfocarlo.
- **Ventana al cielo.** Pantalla completa del cielo en la dirección del teléfono, mira central en `{colors.accent}`, nombre del objeto bajo la mira y un único `button-primary` para abrirlo en el visor.
- No se dibujan barras de estado ni teclados del sistema.

## Do's and Don'ts

### Do
- Dejar que la imagen llegue a los bordes de la ventana.
- Poner cada control en un panel de vidrio con una sola tarea.
- Escribir todo valor numérico en mono, con su unidad.
- Marcar la selección con blanco sólido y reservar el ámbar para la mira, la época actual, el progreso y la acción principal.
- Acompañar cada indicador gráfico (barra, punto, icono) con texto.

### Don't
- No agregar un segundo color, ni violetas o púrpuras, ni colores de estado.
- No usar barras laterales o cabeceras opacas.
- No usar sombras, brillos ni degradados decorativos.
- No usar emojis ni iconos rellenos.
- No tapar el centro de la imagen con un panel.
- No poner más de un botón relleno de acento en la misma vista.

## Iteration Guide

1. Trabajar un componente por vez y nombrarlo por su token (`{components.glass-panel}`, `{colors.accent}`).
2. Antes de usar el acento en un elemento nuevo, comprobar que entra en uno de sus cuatro usos; si no entra, va en blanco.
3. Las variantes nuevas se agregan como entradas separadas, sin modificar las existentes.
4. Todo texto nuevo se escribe en español e inglés y se prueba con la versión más larga.
5. Las imágenes, el espectro y los avisos de las maquetas son simulados; coordenadas, distancias y bandas deben verificarse contra el catálogo antes de publicar.
6. Ejecutar `npx @google/design.md lint DESIGN.md` después de cada cambio.
