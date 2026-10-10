/**
 * Serializes an object to a JSON string safe to embed in an HTML <script> tag.
 *
 * To prevent Cross-Site Scripting (XSS) and premature closing of <script> blocks,
 * this function escapes:
 * - `<` as `\u003c`
 * - `>` as `\u003e`
 * - `&` as `\u0026`
 * - U+2028 (LINE SEPARATOR) as `\u2028`
 * - U+2029 (PARAGRAPH SEPARATOR) as `\u2029`
 *
 * Valid JSON parsers (e.g. JSON.parse or browser JSON-LD parsers) treat Unicode
 * escape sequences identically to the unescaped characters, preserving the original
 * string value completely while rendering HTML injection impossible.
 */
export function jsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
