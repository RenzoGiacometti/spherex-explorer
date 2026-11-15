// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSseParser, type SseMessage } from "./sseParser";

function parse(chunks: string[]): { messages: SseMessage[]; retries: number[] } {
  const messages: SseMessage[] = [];
  const retries: number[] = [];
  const parser = createSseParser({
    onMessage: (message) => messages.push(message),
    onRetry: (milliseconds) => retries.push(milliseconds),
  });
  for (const chunk of chunks) parser.feed(chunk);
  return { messages, retries };
}

describe("createSseParser", () => {
  it("arma un evento con event, id y data", () => {
    const { messages } = parse(['event: queued\nid: 2\ndata: {"position":2}\n\n']);
    expect(messages).toEqual([{ event: "queued", id: "2", data: '{"position":2}' }]);
  });

  it("lee el ejemplo del contrato: varios eventos seguidos", () => {
    const { messages } = parse([
      'event: state\nid: 1\ndata: {"status":"queued"}\n\n' +
        'event: listed\nid: 3\ndata: {"status":"downloading"}\n\n' +
        'event: done\nid: 412\ndata: {"status":"ready","rev":1,"elapsed_s":155.4}\n\n',
    ]);
    expect(messages.map((message) => message.event)).toEqual(["state", "listed", "done"]);
    expect(messages.map((message) => message.id)).toEqual(["1", "3", "412"]);
    expect(messages[2]?.data).toBe('{"status":"ready","rev":1,"elapsed_s":155.4}');
  });

  it("no emite nada hasta la linea vacia que cierra el evento", () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser({ onMessage: (message) => messages.push(message) });

    parser.feed('event: progress\ndata: {"phase":"downloading"}\n');
    expect(messages).toHaveLength(0);

    parser.feed("\n");
    expect(messages).toHaveLength(1);
  });

  it("junta un evento partido en cualquier punto entre pedazos", () => {
    const text = 'event: plane\nid: 10\ndata: {"plane":{"epoch":1}}\n\n';
    for (let cut = 1; cut < text.length; cut += 1) {
      const { messages } = parse([text.slice(0, cut), text.slice(cut)]);
      expect(messages, `corte en ${cut}`).toEqual([
        { event: "plane", id: "10", data: '{"plane":{"epoch":1}}' },
      ]);
    }
  });

  it("ignora los comentarios, como el ping del backend", () => {
    const { messages } = parse([": ping\n\n", 'event: queued\ndata: {"position":1}\n\n: ping\n\n']);
    expect(messages).toEqual([{ event: "queued", id: "", data: '{"position":1}' }]);
  });

  it("acepta finales de linea CRLF y CR", () => {
    expect(parse(["event: a\r\ndata: 1\r\n\r\n"]).messages).toEqual([
      { event: "a", id: "", data: "1" },
    ]);
    // Con CR solo, el ultimo CR queda en espera por si es la mitad de un CRLF:
    // el evento sale cuando llega el pedazo siguiente.
    expect(parse(["event: b\rdata: 2\r\r"]).messages).toEqual([]);
    expect(parse(["event: b\rdata: 2\r\r", ": ping\r"]).messages).toEqual([
      { event: "b", id: "", data: "2" },
    ]);
  });

  it("no cuenta dos lineas cuando un CRLF llega partido entre pedazos", () => {
    const { messages } = parse(["event: a\r", "\ndata: 1\r", "\n\r", "\n"]);
    expect(messages).toEqual([{ event: "a", id: "", data: "1" }]);
  });

  it("une varias lineas data con salto de linea", () => {
    const { messages } = parse(["data: uno\ndata: dos\n\n"]);
    expect(messages[0]?.data).toBe("uno\ndos");
  });

  it("usa message como nombre si no viene el campo event", () => {
    const { messages } = parse(["data: suelto\n\n"]);
    expect(messages[0]?.event).toBe("message");
  });

  it("descarta solo un espacio despues de los dos puntos", () => {
    const { messages } = parse(["data:sin espacio\n\n", "data:  dos espacios\n\n"]);
    expect(messages.map((message) => message.data)).toEqual(["sin espacio", " dos espacios"]);
  });

  it("no emite un evento sin data y olvida su nombre", () => {
    const { messages } = parse(["event: vacio\n\n", "data: x\n\n"]);
    expect(messages).toEqual([{ event: "message", id: "", data: "x" }]);
  });

  it("conserva el ultimo id para los eventos que no traen uno", () => {
    const { messages } = parse(["id: 7\ndata: a\n\n", "data: b\n\n"]);
    expect(messages.map((message) => message.id)).toEqual(["7", "7"]);
  });

  it("ignora la marca de orden de bytes al principio del flujo", () => {
    const { messages } = parse([`${String.fromCharCode(0xfeff)}data: x\n\n`]);
    expect(messages).toEqual([{ event: "message", id: "", data: "x" }]);
  });

  it("informa el campo retry si es un entero", () => {
    const { retries, messages } = parse(["retry: 3000\n\n", "retry: pronto\n\n"]);
    expect(retries).toEqual([3000]);
    expect(messages).toHaveLength(0);
  });

  it("ignora los campos desconocidos y las lineas sin dos puntos", () => {
    const { messages } = parse(["otro: valor\nsuelta\ndata: x\n\n"]);
    expect(messages).toEqual([{ event: "message", id: "", data: "x" }]);
  });
});
