import sharp from 'sharp';
import jsQR from 'jsqr';
import type { BillingProvider } from '../types';

/**
 * Decodes the QR code out of an uploaded receipt screenshot **on our own
 * server**, then hands the reference to the ordinary text lookup endpoints.
 *
 * The verification API also sells an "read this image" endpoint, but it needs
 * a separate image-credit plan. Decoding here means a screenshot costs exactly
 * the same as a typed transaction ID, and no gym owner's receipt image ever
 * leaves this machine.
 */

export interface QrResult {
  ok: boolean;
  provider: Exclude<BillingProvider, 'CASH'> | null;
  reference: string | null;
  /** Last 8 digits of an involved account, when the payload carried them. */
  accountSuffix: string | null;
  payload: string | null;
  error: string | null;
}

/**
 * Decoding is a ladder of attempts, and that is not optional: QR decoders are
 * finicky about scale — the same code reads at 600px wide and misses at 700 —
 * and a raw 1080×2400 phone screenshot is a lot of pixels to hold at once.
 * Bound the longest edge first, then try progressively narrower widths.
 */
const MAX_EDGE = 700;
const WIDTH_LADDER = [700, 560, 440, 350, 280];

export async function decode(buffer: Buffer): Promise<QrResult> {
  let payload: string | null = null;

  try {
    const meta = await sharp(buffer).metadata();
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    const boundedWidth =
      longest > MAX_EDGE && meta.width
        ? Math.round(meta.width * (MAX_EDGE / longest))
        : (meta.width ?? MAX_EDGE);

    const widths = [...WIDTH_LADDER.filter((w) => w < boundedWidth), boundedWidth];

    for (const width of widths) {
      payload = await readAt(buffer, width);
      if (payload) break;
    }
  } catch (err) {
    console.warn('[qr] image could not be read:', (err as Error).message);
    return {
      ok: false,
      provider: null,
      reference: null,
      accountSuffix: null,
      payload: null,
      error: 'That file could not be read as an image. Upload a PNG, JPG or WebP screenshot.',
    };
  }

  if (!payload) {
    return {
      ok: false,
      provider: null,
      reference: null,
      accountSuffix: null,
      payload: null,
      error:
        'No QR code could be read in that screenshot. Make sure the whole QR square is visible and in focus, ' +
        'or switch to the "Enter transaction ID" tab and type the reference instead.',
    };
  }

  const parsed = parsePayload(payload);
  if (!parsed.reference) {
    return {
      ok: false,
      provider: parsed.provider,
      reference: null,
      accountSuffix: null,
      payload,
      error:
        'The QR code in that screenshot is not a payment receipt we recognise. ' +
        'Try the "Enter transaction ID" tab instead.',
    };
  }
  return { ok: true, ...parsed, payload, error: null };
}

/** One rung of the ladder. A rung that does not read is normal, not exceptional. */
async function readAt(buffer: Buffer, width: number): Promise<string | null> {
  try {
    const { data, info } = await sharp(buffer)
      .resize({ width, fit: 'inside', withoutEnlargement: true, kernel: 'cubic' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const code = jsQR(new Uint8ClampedArray(data), info.width, info.height, {
      inversionAttempts: 'attemptBoth',
    });
    return code?.data?.trim() || null;
  } catch (err) {
    console.debug(`[qr] rung ${width}px failed:`, (err as Error).message);
    return null;
  }
}

// ------------------------------------------------------------- payloads ----

type Parsed = Pick<QrResult, 'provider' | 'reference' | 'accountSuffix'>;

/**
 * The QR is authoritative about which provider issued the receipt; the radio
 * button on the form is only a hint. When the payload identifies the provider
 * we return it, and the caller overrides whatever was submitted.
 */
export function parsePayload(payload: string): Parsed {
  const text = payload.trim();

  // 1. CBE receipt URL — https://apps.cbe.com.et:100/?id=FT25174XNRV064679164
  //    The `id` is the reference followed by the last 8 digits of an involved
  //    account, so it must be split rather than sent as one blob.
  const cbeUrl = text.match(/apps\.cbe\.com\.et[^?]*\?(?:.*&)?id=([A-Za-z0-9]+)/i);
  if (cbeUrl?.[1]) {
    const id = cbeUrl[1].toUpperCase();
    const split = id.match(/^([A-Z0-9]{4,}?)(\d{8})$/);
    return split?.[1] && split[2]
      ? { provider: 'CBE', reference: split[1], accountSuffix: split[2] }
      : { provider: 'CBE', reference: id, accountSuffix: null };
  }

  // 2. Newer CBE short-link — https://mbreciept.cbe.com.et/v2-hfHCxzxlYzc8nHWc1MJG
  //    The token is opaque and carries no reference; the API resolves the whole
  //    URL to the canonical reference. Tokens are CASE-SENSITIVE — do not upper-case.
  if (/mbreciept\.cbe\.com\.et|mbreceipt\.cbe\.com\.et/i.test(text)) {
    return { provider: 'CBE', reference: text, accountSuffix: null };
  }

  // 3. Wallet receipt URL — https://transactioninfo.ethiotelecom.et/receipt/CFG12H34IJ
  if (/transactioninfo\.ethiotelecom\.et/i.test(text)) {
    const last = text.split('/').filter(Boolean).pop() ?? '';
    if (/^[A-Za-z0-9]{6,32}$/.test(last)) {
      return { provider: 'TELEBIRR', reference: last.toUpperCase(), accountSuffix: null };
    }
    return { provider: 'TELEBIRR', reference: null, accountSuffix: null };
  }

  // 4. Base64-wrapped EMVCo TLV (the other shape wallet QRs come in).
  const tlv = parseEmvcoTlv(text);
  if (tlv) return { provider: 'TELEBIRR', reference: tlv, accountSuffix: null };

  // 5. Bare reference.
  if (/^[A-Za-z0-9][A-Za-z0-9-]{5,63}$/.test(text)) {
    // Only safe to upper-case when it is purely alphanumeric — see the
    // case-sensitive short-link note above.
    return { provider: null, reference: /^[A-Za-z0-9]+$/.test(text) ? text.toUpperCase() : text, accountSuffix: null };
  }

  return { provider: null, reference: null, accountSuffix: null };
}

/**
 * EMVCo-style TLV, base64-wrapped. Decoded example:
 *
 *   80 18 000206010291020131
 *   81 24 000A44475034383842514334
 *   63 04 1ECD
 *
 * 2-digit tag, 2-digit DECIMAL length, then the value. Tag 81 holds the
 * receipt number as a 4-hex-digit character count (`000A` = 10) followed by
 * that many hex-encoded bytes (`4447…3434` → `DGP488BQC4`). Tag 63 is a
 * CRC16-CCITT over everything up to and including its own `6304` header.
 *
 * The entries must account for the WHOLE string — that exactness is the
 * structural check that stops arbitrary hex being read as a receipt.
 */
export function parseEmvcoTlv(payload: string): string | null {
  let text = payload.trim();

  // May arrive base64-wrapped or as raw hex/ASCII TLV.
  if (!/^\d{2}\d{2}/.test(text) || /[^0-9A-Za-z]/.test(text)) {
    try {
      const decoded = Buffer.from(text, 'base64').toString('ascii');
      if (/^[0-9A-Za-z]+$/.test(decoded)) text = decoded;
    } catch {
      return null;
    }
  }
  if (!/^[0-9A-Za-z]{8,}$/.test(text)) return null;

  const entries: { tag: string; value: string }[] = [];
  let i = 0;
  while (i < text.length) {
    if (i + 4 > text.length) return null; // trailing junk — not a TLV string
    const tag = text.slice(i, i + 2);
    const lengthText = text.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lengthText)) return null;
    const length = Number(lengthText);
    const end = i + 4 + length;
    if (end > text.length) return null;
    entries.push({ tag, value: text.slice(i + 4, end) });
    i = end;
  }
  if (entries.length === 0) return null;

  const crcEntry = entries.find((e) => e.tag === '63');
  if (crcEntry) {
    const upTo = text.slice(0, text.indexOf('6304') + 4);
    const expected = crc16ccitt(upTo).toString(16).toUpperCase().padStart(4, '0');
    if (expected !== crcEntry.value.toUpperCase()) {
      // Logged, not fatal: a wrong reference simply comes back "not found"
      // from the provider, which beats refusing a readable receipt.
      console.warn(`[qr] TLV CRC mismatch (expected ${expected}, got ${crcEntry.value})`);
    }
  }

  const receiptEntry = entries.find((e) => e.tag === '81');
  if (!receiptEntry) return null;
  return decodeHexCounted(receiptEntry.value);
}

/** `000A44475034383842514334` → 10 chars of hex-encoded ASCII → `DGP488BQC4`. */
function decodeHexCounted(value: string): string | null {
  if (value.length < 4) return null;
  const count = parseInt(value.slice(0, 4), 16);
  if (!Number.isFinite(count) || count <= 0) return null;
  const hex = value.slice(4, 4 + count * 2);
  if (hex.length !== count * 2 || !/^[0-9A-Fa-f]+$/.test(hex)) return null;
  const decoded = Buffer.from(hex, 'hex').toString('ascii');
  return /^[A-Za-z0-9]{4,32}$/.test(decoded) ? decoded : null;
}

export function crc16ccitt(text: string): number {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i += 1) {
    crc ^= text.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
