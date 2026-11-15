// Analizador del formato text/event-stream (HTML Living Standard, seccion
// "Server-sent events", "Interpreting an event stream").
//
// Recibe el texto por pedazos, como llega de la red, y arma los mensajes:
// - una linea "campo: valor" por dato; el espacio despues de los dos puntos se descarta;
// - las lineas que empiezan con ":" son comentarios (el ": ping" del backend);
// - varias lineas "data" se unen con salto de linea;
// - una linea vacia cierra el mensaje;
// - las lineas pueden terminar en "\n", "\r\n" o "\r".

export interface SseMessage {
  /** Nombre del evento; "message" si no vino el campo `event`. */
  event: string;
  /** Contenido de `data`. */
  data: string;
  /** Ultimo `id` recibido en el flujo, o "" si no hubo ninguno. */
  id: string;
}

export interface SseParser {
  /** Agrega texto recien llegado. Los mensajes completos salen por el callback. */
  feed(chunk: string): void;
}

export interface SseParserHandlers {
  onMessage: (message: SseMessage) => void;
  /** Campo `retry`: tiempo de reconexion que sugiere el servidor, en ms. */
  onRetry?: (milliseconds: number) => void;
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

export function createSseParser(handlers: SseParserHandlers): SseParser {
  let buffer = "";
  let started = false;
  let eventName = "";
  let dataLines: string[] = [];
  let lastEventId = "";

  function dispatch(): void {
    // Sin lineas "data" no hay mensaje: solo se descarta el nombre del evento.
    if (dataLines.length > 0) {
      handlers.onMessage({
        event: eventName === "" ? "message" : eventName,
        data: dataLines.join("\n"),
        id: lastEventId,
      });
    }
    eventName = "";
    dataLines = [];
  }

  function processLine(line: string): void {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        eventName = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        if (!value.includes("\0")) lastEventId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) handlers.onRetry?.(Number(value));
        break;
      default:
        // Campo desconocido: se ignora.
        break;
    }
  }

  return {
    feed(chunk) {
      buffer += chunk;
      if (!started && buffer.length > 0) {
        started = true;
        if (buffer.startsWith(BYTE_ORDER_MARK)) buffer = buffer.slice(1);
      }

      const lineEnd = /\r\n|\n|\r/g;
      let start = 0;
      for (let match = lineEnd.exec(buffer); match !== null; match = lineEnd.exec(buffer)) {
        // Un "\r" al final puede ser la primera mitad de "\r\n": se espera al proximo pedazo.
        if (match[0] === "\r" && match.index === buffer.length - 1) break;
        processLine(buffer.slice(start, match.index));
        start = match.index + match[0].length;
      }
      buffer = buffer.slice(start);
    },
  };
}
