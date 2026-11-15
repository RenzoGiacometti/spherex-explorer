// Opciones de compilacion del despliegue publico (las fija el Dockerfile).

/**
 * Falso cuando se compila con VITE_WIDE_FIELD=0: la interfaz no ofrece el campo
 * de 30', que todavia no se probo con datos reales.
 */
export const WIDE_FIELD_ENABLED: boolean = import.meta.env.VITE_WIDE_FIELD !== "0";
