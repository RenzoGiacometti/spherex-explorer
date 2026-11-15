// Despliegue publico: el backend solo sirve los campos precalculados
// (SPHEREX_PRECOMPUTED_ONLY) y esos campos existen solo en el escalon base de
// 10'. El Dockerfile compila el frontend con VITE_PRECOMPUTED_ONLY=1 para que
// la interfaz no ofrezca lo que ese servidor no puede dar.

/** Verdadero en la compilacion del despliegue publico. */
export const PRECOMPUTED_ONLY: boolean = import.meta.env.VITE_PRECOMPUTED_ONLY === "1";
