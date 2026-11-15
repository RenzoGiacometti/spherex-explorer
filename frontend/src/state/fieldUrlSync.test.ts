import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fieldMetaSchema, trackResponseSchema } from "@/api/schema";
import { INITIAL_FIELD_STATE } from "@/data/fieldState";
import { planeKey } from "@/data/planeKey";
import {
  selectIsProvisional,
  selectSaturatedRegions,
  selectTargetPosition,
  selectTargetTrail,
  selectTimeline,
} from "@/data/selectors";
import barnardTrack from "@/test/fixtures/barnard/track_name-barnard-s-star.json";
import barnardMeta from "@/test/fixtures/meta-barnard.json";
import wiseMeta from "@/test/fixtures/meta-wise0855.json";
import { useFieldStore } from "./fieldStore";
import { createFakeBackend } from "./fieldStore.testkit";
import { bindFieldToUrl, savedFieldPatch, useFieldUrlSync } from "./fieldUrlSync";
import { parseUrlState, type UrlState, useUrlState } from "./urlState";

const WISE_URL = "/?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink";

function openUrl(url: string): void {
  window.history.replaceState(null, "", url);
  useUrlState.getState().syncFromLocation();
}

beforeEach(() => {
  openUrl("/");
});

afterEach(() => {
  useFieldStore.getState().close();
  openUrl("/");
});

describe("bindFieldToUrl", () => {
  it("aplica la URL actual, sigue cada cambio y deja de seguir al cortar", () => {
    const seen: UrlState[] = [];
    const field = { getState: () => ({ syncWithUrl: (url: UrlState) => seen.push(url) }) };
    openUrl(WISE_URL);

    const unbind = bindFieldToUrl(useUrlState, field);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ ra: 133.7598, dec: -7.2422, fov: 0.1667, band: 6 });

    useUrlState.getState().update({ band: 2 });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.band).toBe(2);

    useUrlState
      .getState()
      .update({ ra: 269.4463, dec: 4.7683, name: "Barnard's Star" }, { history: "push" });
    expect(seen[2]).toMatchObject({ ra: 269.4463, dec: 4.7683, name: "Barnard's Star" });

    unbind();
    useUrlState.getState().update({ band: 4 });
    expect(seen).toHaveLength(3);
  });
});

describe("savedFieldPatch", () => {
  const WISE_NAME = "WISE J085510.83-071442.5";

  it("lleva unas coordenadas dentro de la huella al campo guardado, con su nombre y su banda", () => {
    // Coordenadas de 2010 de WISE 0855: a 126 segundos de arco del centro guardado.
    const search = "?ra=133.7951&dec=-7.2451";
    expect(savedFieldPatch(parseUrlState(search), search)).toEqual({
      ra: 133.7598,
      dec: -7.2422,
      name: WISE_NAME,
      band: 6,
    });
    // El centro exacto sin nombre tambien: le faltan el nombre y la banda.
    const center = "?ra=133.7598&dec=-7.2422&fov=0.1667&mode=sum";
    expect(savedFieldPatch(parseUrlState(center), center)).toEqual({
      ra: 133.7598,
      dec: -7.2422,
      name: WISE_NAME,
      band: 6,
    });
  });

  it("respeta la banda que la URL ya trae", () => {
    const search = "?ra=133.7951&dec=-7.2451&band=2";
    expect(savedFieldPatch(parseUrlState(search), search)).toEqual({
      ra: 133.7598,
      dec: -7.2422,
      name: WISE_NAME,
      band: 2,
    });
    // El link al centro exacto, armado sin nombre: gana el nombre y conserva su banda.
    const center = "?ra=133.7598&dec=-7.2422&fov=0.1667&band=3&mode=blink";
    expect(savedFieldPatch(parseUrlState(center), center)).toEqual({
      ra: 133.7598,
      dec: -7.2422,
      name: WISE_NAME,
      band: 3,
    });
  });

  it("no toca una URL con nombre, sin campo o fuera de toda huella", () => {
    for (const search of [
      "",
      "?lang=en",
      // Ya trae un nombre: alguien eligio ese objeto.
      "?ra=133.7951&dec=-7.2451&name=Otro+objeto",
      `?ra=133.7598&dec=-7.2422&band=6&name=${encodeURIComponent(WISE_NAME)}`,
      // M 31, y un punto a 10 minutos de arco de Barnard.
      "?ra=10.6847&dec=41.269",
      "?ra=269.4463&dec=4.935",
    ]) {
      expect(savedFieldPatch(parseUrlState(search), search), search).toBeNull();
    }
  });
});

describe("bindFieldToUrl con un campo guardado", () => {
  it("un link con coordenadas dentro de la huella abre el campo guardado y corrige la URL", () => {
    const seen: UrlState[] = [];
    const field = { getState: () => ({ syncWithUrl: (url: UrlState) => seen.push(url) }) };
    openUrl("/?ra=133.7951&dec=-7.2451&lang=en");
    const before = window.history.length;

    const unbind = bindFieldToUrl(useUrlState, field);

    // Lo unico que se aplica es el campo guardado: el de al lado no se llega a pedir.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      ra: 133.7598,
      dec: -7.2422,
      band: 6,
      name: "WISE J085510.83-071442.5",
      lang: "en",
    });
    expect(window.location.search).toBe(
      "?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink&name=WISE+J085510.83-071442.5&lang=en",
    );
    // Se corrige la misma entrada del historial.
    expect(window.history.length).toBe(before);

    // Lo mismo al navegar despues a otro punto sin nombre; la banda escrita se respeta.
    useUrlState
      .getState()
      .update({ ra: 269.4458, dec: 4.7683, band: 2, name: null }, { history: "push" });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ ra: 269.4463, dec: 4.7683, band: 2, name: "Barnard's Star" });
    expect(window.history.length).toBe(before + 1);

    // Un punto lejos de todo campo guardado pasa como esta.
    useUrlState.getState().update({ ra: 10.6847, dec: 41.269, name: null }, { history: "push" });
    expect(seen[2]).toMatchObject({ ra: 10.6847, dec: 41.269, name: null });

    unbind();
  });
});

describe("useFieldUrlSync", () => {
  it("abre el campo de la URL, sigue la banda y lo cierra al volver a la entrada", async () => {
    const backend = createFakeBackend(structuredClone(wiseMeta));
    // El store por defecto usa el fetch global, resuelto en cada pedido.
    vi.stubGlobal("fetch", backend.fetch);
    backend.hold("cube");

    openUrl(WISE_URL);
    const { unmount } = renderHook(() => useFieldUrlSync());

    await vi.waitFor(() => expect(useFieldStore.getState().phase).toBe("ready"));
    expect(backend.requests("field")[0]?.body).toEqual({
      ra: 133.7598,
      dec: -7.2422,
      fov: 0.1667,
      band: 6,
    });
    await vi.waitFor(() => expect(useFieldStore.getState().planes[planeKey(3, 6)]?.rev).toBe(2));

    // Otra banda en la URL: mismo campo, sin otro POST.
    useUrlState.getState().update({ band: 1 });
    expect(useFieldStore.getState().band).toBe(1);
    await vi.waitFor(() => expect(useFieldStore.getState().planes[planeKey(3, 1)]?.rev).toBe(2));
    // Modo y epoca no tocan el campo.
    const before = backend.calls.length;
    useUrlState.getState().update({ mode: "difference", epoch: 2 });
    expect(backend.calls).toHaveLength(before);
    expect(backend.requests("field")).toHaveLength(1);

    // Sin coordenadas en la URL se vuelve a la entrada y el campo se cierra.
    useUrlState.getState().update({ ra: null, dec: null });
    expect(useFieldStore.getState().phase).toBe("idle");
    expect(useFieldStore.getState().planes).toEqual({});

    unmount();
  });
});

describe("selectores como hooks", () => {
  it("se dibuja con cada cambio de lo seleccionado y no vuelve a dibujar sin fin", async () => {
    const backend = createFakeBackend(structuredClone(wiseMeta));
    vi.stubGlobal("fetch", backend.fetch);
    backend.hold("plane");
    backend.hold("cube");

    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return {
        timeline: useFieldStore(selectTimeline),
        provisional: useFieldStore((state) => selectIsProvisional(state, 1)),
        regions: useFieldStore((state) => selectSaturatedRegions(state, 1)),
        phase: useFieldStore((state) => state.phase),
      };
    });
    expect(result.current.timeline).toEqual([]);

    await act(() =>
      useFieldStore.getState().openField({ ra: 133.7598, dec: -7.2422, fov: 0.1667, band: 6 }),
    );
    expect(result.current.phase).toBe("ready");
    expect(result.current.timeline.map((entry) => entry.state)).toEqual([
      "unloaded",
      "unloaded",
      "unloaded",
    ]);

    await act(async () => {
      backend.release("plane");
      await vi.waitFor(() => expect(Object.keys(useFieldStore.getState().planes)).toHaveLength(3));
    });
    expect(result.current.timeline.map((entry) => entry.state)).toEqual([
      "loaded",
      "loaded",
      "loaded",
    ]);
    expect(result.current.provisional).toBe(false);
    expect(result.current.regions).toEqual([]);
    // Unos pocos dibujos por cambio de estado, no un ciclo.
    expect(renders).toBeLessThan(20);
  });

  it("un selector con epoca sirve para dos epocas a la vez: la mira de A y la de B, y el rastro", () => {
    const track = trackResponseSchema.parse(barnardTrack);
    act(() => {
      useFieldStore.setState({
        meta: fieldMetaSchema.parse(barnardMeta),
        target: {
          ...INITIAL_FIELD_STATE.target,
          name: "Barnard's Star",
          trackStatus: "ready",
          track,
        },
      });
    });

    // Con una sola memoria para todas las epocas, cada hook invalidaba la del
    // otro y React cortaba con "Maximum update depth exceeded".
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return {
        a: useFieldStore((state) => selectTargetPosition(state, 1)),
        b: useFieldStore((state) => selectTargetPosition(state, 2)),
        trail: useFieldStore(selectTargetTrail),
      };
    });
    // Y otro componente, con otra epoca, al mismo tiempo.
    const other = renderHook(() => useFieldStore((state) => selectTargetPosition(state, 3)));

    expect(result.current.a?.x).toBe(track.positions[0]?.x);
    expect(result.current.b?.x).toBe(track.positions[1]?.x);
    expect(other.result.current?.x).toBe(track.positions[2]?.x);
    expect(result.current.trail.map((item) => item.epoch)).toEqual([1, 2, 3]);
    expect(result.current.trail[1]?.position).toBe(result.current.b);

    // Un cambio del store que no toca al objeto no vuelve a dibujar.
    const before = renders;
    act(() => {
      useFieldStore.setState({ stream: "open" });
    });
    expect(renders).toBe(before);
    expect(renders).toBeLessThan(4);
  });
});
