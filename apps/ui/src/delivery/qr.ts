/**
 * QR matrix for a delivered URI (06 UI-16 rules), computed in the browser with the pinned `qrcode`
 * (plan/10 §2.2). Byte mode (UTF-8) so the symbol carries the URI byte for byte; level M, level L
 * above 2,000 bytes, no QR above 2,900 bytes.
 */
import QRCode from 'qrcode';

export const QR_L_ABOVE = 2_000;
export const QR_MAX_BYTES = 2_900;
export const QUIET_ZONE = 4;

export interface QrMatrix {
  size: number;
  level: 'M' | 'L';
  /** row-major, 1 = dark */
  modules: Uint8Array;
}

/** Length of a string in UTF-8 bytes, which is what a QR code stores. */
export const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/** Chooses the QR error-correction level for a URI (lower for long ones); null when it cannot fit. */
export function qrLevel(uri: string): 'M' | 'L' | null {
  const n = utf8Length(uri);
  if (n > QR_MAX_BYTES) return null;
  return n > QR_L_ABOVE ? 'L' : 'M';
}

/** Encodes a URI as a QR module matrix, or null when it is too long for one code. */
export function qrMatrix(uri: string): QrMatrix | null {
  const level = qrLevel(uri);
  if (!level) return null;
  const q = QRCode.create([{ data: new TextEncoder().encode(uri), mode: 'byte' }], {
    errorCorrectionLevel: level,
  });
  return { size: q.modules.size, level, modules: Uint8Array.from(q.modules.data) };
}

/** one SVG path for every dark module, in module units offset by the quiet zone */
export function qrPath(m: QrMatrix): string {
  let d = '';
  for (let r = 0; r < m.size; r++) {
    let c = 0;
    while (c < m.size) {
      if (!m.modules[r * m.size + c]) {
        c++;
        continue;
      }
      const start = c;
      while (c < m.size && m.modules[r * m.size + c]) c++;
      d += `M${start + QUIET_ZONE} ${r + QUIET_ZONE}h${c - start}v1h${start - c}z`;
    }
  }
  return d;
}
