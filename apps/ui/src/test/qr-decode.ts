/**
 * Test-only QR decoder (T-31 "the QR decodes to exactly the deliver-request URI"). Reads a module
 * matrix as drawn (the SVG's dark modules), independent of the encoder: format info → EC level and
 * mask, function patterns from ISO/IEC 18004, zigzag read, block de-interleave, byte/alnum/numeric
 * segments. No error correction (a freshly drawn symbol has no errors). plan/10 §2 lists no decoder.
 */

// ISO/IEC 18004 Table 9, levels L and M (index = version)
const ECC_PER_BLOCK = {
  L: [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30,
    30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  M: [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
} as const;
const NUM_BLOCKS = {
  L: [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14,
    15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  M: [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23,
    25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
} as const;
const ECL_BITS: Record<number, 'L' | 'M' | 'Q' | 'H'> = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };

export type Grid = (r: number, c: number) => boolean;

function alignmentCenters(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const num = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (num * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < num; pos -= step) out.splice(1, 0, pos);
  return out;
}

function functionMask(version: number): boolean[][] {
  const size = version * 4 + 17;
  const f = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fill = (r0: number, c0: number, h: number, w: number) => {
    for (let r = r0; r < r0 + h; r++)
      for (let c = c0; c < c0 + w; c++)
        if (r >= 0 && c >= 0 && r < size && c < size) f[r]![c] = true;
  };
  // finders + separators + format areas
  fill(0, 0, 9, 9);
  fill(0, size - 8, 9, 8);
  fill(size - 8, 0, 8, 9);
  // timing
  fill(6, 0, 1, size);
  fill(0, 6, size, 1);
  // alignment
  const al = alignmentCenters(version);
  for (const r of al)
    for (const c of al) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6))
        continue;
      fill(r - 2, c - 2, 5, 5);
    }
  // version info
  if (version >= 7) {
    fill(0, size - 11, 6, 3);
    fill(size - 11, 0, 3, 6);
  }
  return f;
}

const MASKS: ((i: number, j: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

export function decodeQr(size: number, dark: Grid): string {
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 40)
    throw new Error(`bad size ${size}`);
  // format info, the copy next to the top-left finder (column 8, read top to bottom)
  let fmt = 0;
  for (let i = 0; i < 15; i++) {
    const r = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
    if (dark(r, 8)) fmt |= 1 << i;
  }
  // second copy (row 8) must agree
  let fmt2 = 0;
  for (let i = 0; i < 15; i++) {
    const c = i < 8 ? size - i - 1 : i < 9 ? 15 - i : 15 - i - 1;
    if (dark(8, c)) fmt2 |= 1 << i;
  }
  if (fmt !== fmt2) throw new Error('format copies differ');
  const data5 = (fmt ^ 0x5412) >> 10;
  const ecl = ECL_BITS[data5 >> 3]!;
  const mask = MASKS[data5 & 7]!;
  if (ecl !== 'L' && ecl !== 'M') throw new Error(`unsupported level ${ecl}`);

  const fn = functionMask(version);
  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) {
      const r = upward ? size - 1 - v : v;
      for (const c of [right, right - 1]) {
        if (fn[r]![c]) continue;
        bits.push((dark(r, c) ? 1 : 0) ^ (mask(r, c) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  const raw = Math.floor(bits.length / 8);
  const words: number[] = [];
  for (let i = 0; i < raw; i++) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i * 8 + k]!;
    words.push(b);
  }
  // de-interleave
  const nb = NUM_BLOCKS[ecl][version]!;
  const ecc = ECC_PER_BLOCK[ecl][version]!;
  const shortLen = Math.floor(raw / nb);
  const numShort = nb - (raw % nb);
  const shortData = shortLen - ecc;
  const blocks: number[][] = Array.from({ length: nb }, () => []);
  let k = 0;
  for (let i = 0; i <= shortLen; i++) {
    for (let j = 0; j < nb; j++) {
      if (i === shortData && j < numShort) continue; // short blocks have no byte here
      blocks[j]!.push(words[k++]!);
    }
  }
  const dataWords: number[] = [];
  blocks.forEach((b, j) => dataWords.push(...b.slice(0, j < numShort ? shortData : shortData + 1)));

  // segments
  let p = 0;
  const total = dataWords.length * 8;
  const read = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, p++) v = (v << 1) | ((dataWords[p >> 3]! >> (7 - (p & 7))) & 1);
    return v;
  };
  const bytes: number[] = [];
  let text = '';
  const flush = () => {
    if (bytes.length)
      text += new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    bytes.length = 0;
  };
  while (p + 4 <= total) {
    const mode = read(4);
    if (mode === 0) break;
    if (mode === 4) {
      const n = read(version < 10 ? 8 : 16);
      for (let i = 0; i < n; i++) bytes.push(read(8));
    } else if (mode === 2) {
      flush();
      let n = read(version < 10 ? 9 : version < 27 ? 11 : 13);
      for (; n >= 2; n -= 2) {
        const v = read(11);
        text += ALNUM[Math.floor(v / 45)]! + ALNUM[v % 45]!;
      }
      if (n === 1) text += ALNUM[read(6)]!;
    } else if (mode === 1) {
      flush();
      let n = read(version < 10 ? 10 : version < 27 ? 12 : 14);
      for (; n >= 3; n -= 3) text += String(read(10)).padStart(3, '0');
      if (n === 2) text += String(read(7)).padStart(2, '0');
      else if (n === 1) text += String(read(4));
    } else {
      throw new Error(`unsupported mode ${mode}`);
    }
  }
  flush();
  return text;
}

/** decode the `<svg class="qr">` the QrCode component drew: rebuild the grid from its path */
export function decodeQrSvg(svg: SVGElement, quiet = 4): string {
  const size = Number(svg.getAttribute('data-qr-size'));
  const d = svg.querySelector('path')?.getAttribute('d') ?? '';
  const grid = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-?\d+z/g)) {
    const c0 = Number(m[1]) - quiet;
    const r = Number(m[2]) - quiet;
    for (let c = c0; c < c0 + Number(m[3]); c++) grid[r]![c] = true;
  }
  return decodeQr(size, (r, c) => grid[r]![c]!);
}
