/**
 * Une nombres de clase y descarta los que no estan. Las clases de un CSS
 * Module llegan como `string | undefined`, y las condicionales como `false`.
 */
export function classNames(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join(" ");
}
