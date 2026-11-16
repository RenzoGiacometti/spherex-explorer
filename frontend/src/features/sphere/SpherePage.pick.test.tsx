// El cartel del punto elegido. jsdom no tiene WebGL, asi que la esfera se
// reemplaza por una de prueba: un boton que hace de toque sobre el cielo y un
// `project` que dice donde cae ese punto en la pantalla (o que quedo fuera).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, setLanguage } from "@/i18n";
import { useUrlState } from "@/state/urlState";
import type { SkySphereHandle, SkySphereProps } from "./SkySphere";
import { SpherePage } from "./SpherePage";
import esSphere from "./sphere.es.json";

/** Donde "se ve" el punto elegido; null: fuera de la vista. */
const screenPoint = vi.hoisted(() => ({
  current: { x: 100, y: 200 } as { x: number; y: number } | null,
}));

vi.mock("./SkySphere", async (importOriginal) => {
  const original = await importOriginal<typeof import("./SkySphere")>();
  function FakeSkySphere({ ref, onSkyTap, onViewChange }: SkySphereProps) {
    useImperativeHandle(
      ref,
      () =>
        ({
          getView: () => null,
          project: () => screenPoint.current,
          refresh: () => {},
          setView: () => {},
          setSkyDim: () => {},
          setFreeOrientation: () => {},
        }) as unknown as SkySphereHandle,
    );
    return (
      <>
        <button type="button" onClick={() => onSkyTap?.({ ra: 10.123456, dec: 20 })}>
          tocar el cielo
        </button>
        <button type="button" onClick={() => onViewChange?.({ ra: 0, dec: 0, fov: 60 })}>
          girar el cielo
        </button>
      </>
    );
  }
  return { ...original, SkySphere: FakeSkySphere };
});

function tapSky(): void {
  fireEvent.click(screen.getByRole("button", { name: "tocar el cielo" }));
}

/**
 * El cartel, tambien cuando esta oculto porque el punto salio de la vista: ahi
 * no tiene rol accesible, y por eso se lo busca en el documento.
 */
function callout(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`section[aria-label="${esSphere.pick.title}"]`);
}

beforeEach(async () => {
  window.history.replaceState(null, "", "/");
  useUrlState.getState().syncFromLocation();
  initI18n("es");
  await setLanguage("es");
  screenPoint.current = { x: 100, y: 200 };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SpherePage: cartel del punto elegido", () => {
  it("no hay cartel hasta que se elige un punto", () => {
    render(<SpherePage />);

    expect(callout()).toBeNull();
  });

  it("un toque sobre el cielo abre el cartel, ubicado y a la vista", () => {
    render(<SpherePage />);
    tapSky();

    const card = callout();
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain(esSphere.pick.title);
    expect(card?.textContent).toContain(esSphere.pick.new);
    expect(screen.getByRole("button", { name: esSphere.pick.open })).toBeTruthy();
    expect(card?.style.visibility).toBe("visible");
    expect(card?.style.transform).toMatch(/^translate\(/);
  });

  it("el cartel no saca de su lugar al buscador, los destacados ni el riel", () => {
    render(<SpherePage />);
    tapSky();

    expect(screen.getByRole("searchbox")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: esSphere.markers.nav })).toBeTruthy();
    expect(screen.getByRole("button", { name: esSphere.random })).toBeTruthy();
  });

  it("se oculta cuando el punto sale de la vista y vuelve cuando entra", () => {
    render(<SpherePage />);
    tapSky();

    screenPoint.current = null;
    fireEvent.click(screen.getByRole("button", { name: "girar el cielo" }));
    expect(callout()?.style.visibility).toBe("hidden");

    screenPoint.current = { x: 300, y: 120 };
    fireEvent.click(screen.getByRole("button", { name: "girar el cielo" }));
    expect(callout()?.style.visibility).toBe("visible");
  });

  it("el boton de cerrar quita el cartel", () => {
    render(<SpherePage />);
    tapSky();

    fireEvent.click(screen.getByRole("button", { name: esSphere.pick.close }));
    expect(callout()).toBeNull();
  });

  it("Escape quita el cartel", () => {
    render(<SpherePage />);
    tapSky();

    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(callout()).toBeNull();
  });
});
