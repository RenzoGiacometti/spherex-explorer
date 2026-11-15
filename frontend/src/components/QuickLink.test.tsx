import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuickLink, QuickLinkList } from "./QuickLink";

const HREF = "/?ra=269.4463&dec=4.7683&fov=0.1667&band=3&mode=blink";

describe("QuickLink", () => {
  it("es un enlace de verdad, con el nombre del objeto como esta en el catalogo", () => {
    render(<QuickLink href={HREF}>Barnard's Star</QuickLink>);
    const link = screen.getByRole("link", { name: "Barnard's Star" });

    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe(HREF);
  });

  it("el dato acompana al nombre y se lee separado de el", () => {
    render(
      <QuickLink href={HREF} detail="10,4″ / año">
        Barnard's Star
      </QuickLink>,
    );

    expect(screen.getByRole("link", { name: "Barnard's Star 10,4″ / año" })).toBeTruthy();
    expect(screen.getByText("10,4″ / año")).toBeTruthy();
  });

  it("quien lo usa puede navegar sin recargar", () => {
    const onClick = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <QuickLink href={HREF} onClick={onClick}>
        WISE 0855
      </QuickLink>,
    );

    fireEvent.click(screen.getByRole("link", { name: "WISE 0855" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("suma la clase que recibe", () => {
    render(
      <QuickLink href={HREF} className="extra">
        WISE 0855
      </QuickLink>,
    );
    expect(screen.getByRole("link").classList.contains("extra")).toBe(true);
  });
});

describe("QuickLinkList", () => {
  it("es una navegacion con nombre que contiene los accesos", () => {
    render(
      <QuickLinkList label="Objetos destacados">
        <QuickLink href={HREF}>Barnard's Star</QuickLink>
        <QuickLink href="/?ra=133.7598&dec=-7.2422">WISE 0855</QuickLink>
      </QuickLinkList>,
    );

    const nav = screen.getByRole("navigation", { name: "Objetos destacados" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Barnard's Star", "WISE 0855"]);
  });
});
