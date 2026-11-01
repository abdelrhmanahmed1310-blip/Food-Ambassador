/**
 * A tiny XML writer that emits canonical XML (C14N) directly: no
 * declaration, no whitespace between elements, empty elements written as
 * start and end tags, attributes in the order given (callers give them in
 * canonical order), text and attribute values escaped as C14N does. What is
 * hashed is therefore exactly what ZATCA canonicalises (ADR-064).
 */
export type Child = string | null | undefined | false;

const text = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#xD;");
const attr = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xA;")
    .replace(/\r/g, "&#xD;");

/** An element with attributes and child elements (already written). */
export function el(name: string, attrs: Record<string, string>, ...children: Child[]): string {
  const a = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${attr(v)}"`)
    .join("");
  return `<${name}${a}>${children.filter(Boolean).join("")}</${name}>`;
}

/** An element holding text. */
export function leaf(name: string, value: string, attrs: Record<string, string> = {}): string {
  return el(name, attrs, text(value));
}
