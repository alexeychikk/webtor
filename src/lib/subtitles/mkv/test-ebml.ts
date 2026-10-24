/** A tiny EBML writer for tests: synthetic Matroska headers for cases the fixtures don't have. */

export function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return out;
}
export function sizeBytes(size: number | null): number[] {
  if (size === null) return [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  return [0x10, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff].map((b, i) =>
    i === 0 ? b | ((size / 2 ** 24) & 0x0f) : b,
  );
}
export type Bytes = number[] | Uint8Array;
export const cat = (...parts: Bytes[]) => parts.flatMap((p) => [...p]);
export const el = (id: number, ...body: Bytes[]) => {
  const data = cat(...body);
  return cat(idBytes(id), sizeBytes(data.length), data);
};
export const unknownEl = (id: number, ...body: Bytes[]) =>
  cat(idBytes(id), sizeBytes(null), ...body);
export const uint = (id: number, v: number) => el(id, v === 0 ? [0] : idBytes(v));
export const str = (id: number, s: string) => el(id, new TextEncoder().encode(s));
