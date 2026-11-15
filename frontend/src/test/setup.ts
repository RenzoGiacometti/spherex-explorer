// Preparacion comun de los tests. Los tests importan describe, it y expect de
// "vitest" de forma explicita (sin globales), asi que la limpieza de
// @testing-library/react hay que registrarla a mano.

import { afterEach } from "vitest";

if (typeof document !== "undefined") {
  const { cleanup } = await import("@testing-library/react");
  afterEach(() => {
    cleanup();
  });
}
