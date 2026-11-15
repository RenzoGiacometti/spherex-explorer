// Cola de descargas del campo: limite de pedidos simultaneos, sin pedidos
// duplicados y con cancelacion.
//
// - Cada trabajo tiene una clave. Mientras haya uno con esa clave, en espera o
//   en curso, `add` no agrega otro: devuelve la promesa del que ya esta.
// - La prioridad se evalua al elegir el proximo trabajo y no al encolarlo, asi
//   que sigue a la banda que la persona esta mirando en ese momento. Gana el
//   numero mas bajo; entre iguales, el que llego primero.
// - `cancel` y `cancelAll` cortan los pedidos en curso con su AbortSignal y
//   descartan los que esperan. La cola se puede seguir usando despues.

import { isAbortError } from "@/api/errors";

export interface DownloadJob {
  /** Identifica el trabajo; no puede haber dos con la misma clave a la vez. */
  key: string;
  /** Orden de salida: el numero mas bajo va antes. Se consulta cada vez que hay un lugar libre. */
  priority: () => number;
  /** Hace la descarga. Tiene que respetar `signal` y resolver sus propios errores. */
  run: (signal: AbortSignal) => Promise<void>;
}

export interface DownloadQueue {
  /**
   * Encola un trabajo. La promesa termina cuando el trabajo termina, falla o se
   * cancela; nunca se rechaza. Si ya hay uno con la misma clave devuelve la
   * promesa de ese y no encola nada.
   */
  add(job: DownloadJob): Promise<void>;
  /** Dice si hay un trabajo con esa clave, en espera o en curso. */
  has(key: string): boolean;
  /** Cancela el trabajo con esa clave, si lo hay. */
  cancel(key: string): void;
  /**
   * Descarta los trabajos en espera cuya clave cumple `match` y devuelve sus
   * claves. Los que ya estan en curso siguen: su pedido ya salio.
   */
  cancelWaiting(match: (key: string) => boolean): string[];
  /** Cancela todo: lo que espera y lo que esta en curso. */
  cancelAll(): void;
  /** Pedidos en curso. */
  readonly active: number;
  /** Trabajos en espera. */
  readonly waiting: number;
}

export interface DownloadQueueOptions {
  /** Pedidos simultaneos como maximo. */
  concurrency: number;
}

interface Entry {
  job: DownloadJob;
  controller: AbortController;
  done: Promise<void>;
  settle: () => void;
}

export function createDownloadQueue(options: DownloadQueueOptions): DownloadQueue {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const byKey = new Map<string, Entry>();
  const waiting: Entry[] = [];
  const running = new Set<Entry>();

  /** Saca de la espera el trabajo de menor prioridad; entre iguales, el mas viejo. */
  function takeNext(): Entry | undefined {
    let bestIndex = -1;
    let bestPriority = Number.POSITIVE_INFINITY;
    for (const [index, entry] of waiting.entries()) {
      const priority = entry.job.priority();
      if (priority < bestPriority) {
        bestPriority = priority;
        bestIndex = index;
      }
    }
    return bestIndex < 0 ? undefined : waiting.splice(bestIndex, 1)[0];
  }

  function release(entry: Entry): void {
    // Un trabajo cancelado ya dejo su lugar: no lo libera dos veces.
    if (!running.delete(entry)) return;
    if (byKey.get(entry.job.key) === entry) byKey.delete(entry.job.key);
    entry.settle();
    pump();
  }

  function start(entry: Entry): void {
    running.add(entry);
    let outcome: Promise<void>;
    try {
      outcome = entry.job.run(entry.controller.signal);
    } catch (error) {
      outcome = Promise.reject(error);
    }
    outcome
      .catch((error: unknown) => {
        // Los trabajos resuelven sus errores; lo que llega aca es un descuido.
        if (!isAbortError(error)) {
          console.error(`descarga "${entry.job.key}": error sin manejar`, error);
        }
      })
      .then(() => release(entry));
  }

  function pump(): void {
    while (running.size < concurrency) {
      const next = takeNext();
      if (!next) return;
      start(next);
    }
  }

  function drop(entry: Entry): void {
    const index = waiting.indexOf(entry);
    if (index >= 0) waiting.splice(index, 1);
    running.delete(entry);
    if (byKey.get(entry.job.key) === entry) byKey.delete(entry.job.key);
    entry.controller.abort();
    entry.settle();
  }

  return {
    add(job) {
      const existing = byKey.get(job.key);
      if (existing) return existing.done;

      let settle: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const entry: Entry = { job, controller: new AbortController(), done, settle };
      byKey.set(job.key, entry);
      waiting.push(entry);
      pump();
      return done;
    },

    has(key) {
      return byKey.has(key);
    },

    cancel(key) {
      const entry = byKey.get(key);
      if (!entry) return;
      drop(entry);
      pump();
    },

    cancelWaiting(match) {
      const dropped = waiting.filter((entry) => match(entry.job.key));
      for (const entry of dropped) drop(entry);
      return dropped.map((entry) => entry.job.key);
    },

    cancelAll() {
      for (const entry of [...byKey.values()]) drop(entry);
    },

    get active() {
      return running.size;
    },

    get waiting() {
      return waiting.length;
    },
  };
}
