// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDownloadQueue, type DownloadJob } from "./downloadQueue";

/** Un trabajo que el test termina a mano y que anota cuando empezo y si lo cancelaron. */
function manualJob(key: string, priority: () => number = () => 1) {
  const control = {
    started: false,
    aborted: false,
    finish: () => {},
    fail: (_error: unknown) => {},
  };
  const job: DownloadJob = {
    key,
    priority,
    run: (signal) =>
      new Promise<void>((resolve, reject) => {
        control.started = true;
        control.finish = resolve;
        control.fail = reject;
        signal.addEventListener("abort", () => {
          control.aborted = true;
          reject(signal.reason);
        });
      }),
  };
  return { job, control };
}

/** Deja correr las promesas pendientes. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createDownloadQueue", () => {
  it("no corre mas trabajos a la vez que el limite", async () => {
    const queue = createDownloadQueue({ concurrency: 2 });
    const jobs = ["a", "b", "c", "d"].map((key) => manualJob(key));
    for (const { job } of jobs) void queue.add(job);

    expect(jobs.map(({ control }) => control.started)).toEqual([true, true, false, false]);
    expect(queue.active).toBe(2);
    expect(queue.waiting).toBe(2);

    jobs[0]?.control.finish();
    await flush();
    expect(jobs.map(({ control }) => control.started)).toEqual([true, true, true, false]);
    expect(queue.active).toBe(2);

    jobs[1]?.control.finish();
    jobs[2]?.control.finish();
    await flush();
    expect(jobs[3]?.control.started).toBe(true);
    expect(queue.active).toBe(1);
    expect(queue.waiting).toBe(0);
  });

  it("no agrega un trabajo con una clave que ya esta: devuelve la promesa del primero", async () => {
    const queue = createDownloadQueue({ concurrency: 1 });
    const first = manualJob("plane:1:3");
    const duplicate = manualJob("plane:1:3");

    const firstDone = queue.add(first.job);
    const duplicateDone = queue.add(duplicate.job);

    expect(duplicateDone).toBe(firstDone);
    expect(queue.has("plane:1:3")).toBe(true);
    first.control.finish();
    await firstDone;
    await flush();

    expect(duplicate.control.started).toBe(false);
    expect(queue.has("plane:1:3")).toBe(false);
    expect(queue.active).toBe(0);
  });

  it("despues de terminar, la misma clave se puede volver a encolar", async () => {
    const queue = createDownloadQueue({ concurrency: 1 });
    const first = manualJob("cube");
    const done = queue.add(first.job);
    first.control.finish();
    await done;

    const second = manualJob("cube");
    void queue.add(second.job);
    expect(second.control.started).toBe(true);
  });

  it("elige por prioridad al momento de salir, y entre iguales el mas viejo", async () => {
    const queue = createDownloadQueue({ concurrency: 1 });
    let currentBand = 3;
    const order: string[] = [];
    const tracked = (key: string, band: number) => {
      const { job, control } = manualJob(key, () => (band === currentBand ? 1 : 2));
      const run = job.run;
      job.run = (signal) => {
        order.push(key);
        return run(signal);
      };
      return { job, control };
    };

    const running = tracked("b3-e1", 3);
    const waiting = [tracked("b3-e2", 3), tracked("b6-e1", 6), tracked("b6-e2", 6)];
    void queue.add(running.job);
    for (const { job } of waiting) void queue.add(job);

    // La persona cambia a la banda 6 mientras el primero esta bajando.
    currentBand = 6;
    running.control.finish();
    await flush();
    expect(order).toEqual(["b3-e1", "b6-e1"]);

    waiting[1]?.control.finish();
    await flush();
    waiting[2]?.control.finish();
    await flush();
    expect(order).toEqual(["b3-e1", "b6-e1", "b6-e2", "b3-e2"]);
  });

  it("cancel corta un trabajo en curso, libera su lugar y deja encolar la clave otra vez", async () => {
    const queue = createDownloadQueue({ concurrency: 1 });
    const old = manualJob("plane:1:3");
    const next = manualJob("other");
    const oldDone = queue.add(old.job);
    void queue.add(next.job);

    queue.cancel("plane:1:3");
    await oldDone;

    expect(old.control.aborted).toBe(true);
    expect(next.control.started).toBe(true);
    expect(queue.has("plane:1:3")).toBe(false);

    const replacement = manualJob("plane:1:3");
    void queue.add(replacement.job);
    await flush();
    // El lugar lo tiene `other`; el reemplazo espera, y el corte del viejo no libero dos veces.
    expect(queue.active).toBe(1);
    expect(queue.waiting).toBe(1);
    next.control.finish();
    await flush();
    expect(replacement.control.started).toBe(true);
  });

  it("cancel saca de la espera un trabajo que no empezo", async () => {
    const queue = createDownloadQueue({ concurrency: 1 });
    const running = manualJob("a");
    const waiting = manualJob("b");
    void queue.add(running.job);
    const waitingDone = queue.add(waiting.job);

    queue.cancel("b");
    await waitingDone;
    running.control.finish();
    await flush();

    expect(waiting.control.started).toBe(false);
    expect(queue.active).toBe(0);
    queue.cancel("no existe");
  });

  it("cancelWaiting descarta solo lo que espera y cumple la condicion, y dice que saco", async () => {
    const queue = createDownloadQueue({ concurrency: 1 });
    const running = manualJob("plane:1:3");
    const waiting = ["plane:2:3", "plane:1:6", "cube"].map((key) => manualJob(key));
    void queue.add(running.job);
    const done = waiting.map(({ job }) => queue.add(job));

    const dropped = queue.cancelWaiting((key) => key.endsWith(":3"));

    // El que ya salio sigue, aunque cumpla la condicion.
    expect(dropped).toEqual(["plane:2:3"]);
    expect(running.control.aborted).toBe(false);
    expect(queue.active).toBe(1);
    expect(queue.waiting).toBe(2);
    expect(queue.has("plane:2:3")).toBe(false);
    await done[0];
    expect(waiting[0]?.control.started).toBe(false);

    // La clave descartada se puede volver a encolar, y el resto sale en su orden.
    const again = manualJob("plane:2:3");
    void queue.add(again.job);
    running.control.finish();
    await flush();
    expect(waiting[1]?.control.started).toBe(true);
    expect(queue.cancelWaiting(() => false)).toEqual([]);
  });

  it("cancelAll corta lo que esta en curso, descarta lo que espera y la cola sigue sirviendo", async () => {
    const queue = createDownloadQueue({ concurrency: 2 });
    const jobs = ["a", "b", "c"].map((key) => manualJob(key));
    const done = jobs.map(({ job }) => queue.add(job));

    queue.cancelAll();
    await Promise.all(done);

    expect(jobs.map(({ control }) => control.aborted)).toEqual([true, true, false]);
    expect(jobs[2]?.control.started).toBe(false);
    expect(queue.active).toBe(0);
    expect(queue.waiting).toBe(0);

    const after = manualJob("a");
    void queue.add(after.job);
    expect(after.control.started).toBe(true);
  });

  it("un trabajo que falla libera su lugar y la promesa no se rechaza", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = createDownloadQueue({ concurrency: 1 });
    const failing = manualJob("a");
    const next = manualJob("b");
    const failingDone = queue.add(failing.job);
    void queue.add(next.job);

    failing.control.fail(new Error("fallo sin manejar"));
    await expect(failingDone).resolves.toBeUndefined();

    expect(next.control.started).toBe(true);
    expect(error).toHaveBeenCalledOnce();
  });

  it("un trabajo que lanza al arrancar no traba la cola", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = createDownloadQueue({ concurrency: 1 });
    const next = manualJob("b");
    const thrown = queue.add({
      key: "a",
      priority: () => 1,
      run: () => {
        throw new Error("fallo al arrancar");
      },
    });
    void queue.add(next.job);
    await thrown;

    expect(next.control.started).toBe(true);
    expect(error).toHaveBeenCalledOnce();
  });
});
