import { describe, expect, it } from "vitest";
import { type DevPageLoader, devPageId, devPageIds, findDevPage } from "./devPages";

function Blank(): null {
  return null;
}

const loader: DevPageLoader = () => Promise.resolve({ devPage: { Component: Blank } });
const source = {
  "../viewer/viewer.devpage.tsx": loader,
  "../components/gallery.devpage.tsx": loader,
};

describe("paginas de desarrollo", () => {
  it("el identificador es el nombre del archivo sin la extension", () => {
    expect(devPageId("../components/gallery.devpage.tsx")).toBe("gallery");
    expect(devPageId("viewer.devpage.tsx")).toBe("viewer");
  });

  it("lista los identificadores en orden", () => {
    expect(devPageIds(source)).toEqual(["gallery", "viewer"]);
  });

  it("encuentra una pagina por su identificador", () => {
    expect(findDevPage("viewer", source)).toBe(loader);
    expect(findDevPage("otra", source)).toBeNull();
  });
});
