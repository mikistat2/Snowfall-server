import { describe, it, expect } from 'vitest';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { decode } from '../../src/services/receiptQrService';

/**
 * Exercises the real decode ladder against real QR images, including the sizes
 * a phone actually produces. The unit tests in billing.test.ts cover payload
 * parsing; these cover the part that is finicky about scale.
 */

/** A QR on a white page, optionally padded out to a phone-screenshot size. */
async function screenshot(payload: string, width?: number, height?: number): Promise<Buffer> {
  const qr = await QRCode.toBuffer(payload, { type: 'png', width: 320, margin: 2 });
  if (!width || !height) return qr;
  return sharp({
    create: { width, height, channels: 3, background: '#ffffff' },
  })
    .composite([{ input: qr, top: Math.round(height * 0.25), left: Math.round((width - 320) / 2) }])
    .png()
    .toBuffer();
}

describe('receiptQrService.decode', () => {
  it('reads a CBE receipt URL and splits off the account suffix', async () => {
    const result = await decode(await screenshot('https://apps.cbe.com.et:100/?id=FT25174XNRV064679164'));
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('CBE');
    expect(result.reference).toBe('FT25174XNRV0');
    expect(result.accountSuffix).toBe('64679164');
  });

  it('reads a wallet receipt URL and overrides the provider', async () => {
    const result = await decode(await screenshot('https://transactioninfo.ethiotelecom.et/receipt/CFG12H34IJ'));
    expect(result.ok).toBe(true);
    // the QR is authoritative about the provider; the form's radio is a hint
    expect(result.provider).toBe('TELEBIRR');
    expect(result.reference).toBe('CFG12H34IJ');
  });

  it('preserves the case of a CBE short-link token', async () => {
    const url = 'https://mbreciept.cbe.com.et/v2-hfHCxzxlYzc8nHWc1MJG';
    const result = await decode(await screenshot(url));
    expect(result.reference).toBe(url);
  });

  it('decodes a full-size phone screenshot without exhausting memory', async () => {
    // 1440x3120 is a real flagship screenshot; the ladder bounds it first
    const result = await decode(await screenshot('https://apps.cbe.com.et:100/?id=FT25ABCD123412345678', 1440, 3120));
    expect(result.ok).toBe(true);
    expect(result.reference).toBe('FT25ABCD1234');
  }, 30_000);

  it('decodes an already-small image, where the ladder skips every rung', async () => {
    const result = await decode(await screenshot('FT25ABCD1234'));
    expect(result.ok).toBe(true);
    expect(result.reference).toBe('FT25ABCD1234');
  });

  it('reports something actionable when no QR can be read', async () => {
    const blank = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#eee' } })
      .png()
      .toBuffer();
    const result = await decode(blank);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Enter transaction ID');
  });

  it('reports something actionable when the file is not an image at all', async () => {
    const result = await decode(Buffer.from('this is not an image'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('PNG, JPG or WebP');
  });

  it('rejects a QR that is readable but not a payment receipt', async () => {
    const result = await decode(await screenshot('hi'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not a payment receipt');
  });
});
