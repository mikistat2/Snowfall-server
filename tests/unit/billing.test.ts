import { describe, it, expect } from 'vitest';
import {
  computePeriod,
  matchAccount,
  namesLookAlike,
  resolveCycle,
  runChecks,
  type CheckInput,
} from '../../src/services/billingChecks';
import { normalise, parseAmount, parseReceiptDate } from '../../src/services/verificationService';
import { crc16ccitt, parseEmvcoTlv, parsePayload } from '../../src/services/receiptQrService';
import type { BillingPlanRow, BillingSettings, PaymentCheck } from '../../src/types';

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const PLAN: BillingPlanRow = {
  id: 1,
  name: 'Regular',
  description: null,
  monthly_price: '1200.00',
  yearly_price: '10000.00',
  currency: 'ETB',
  is_active: true,
  sort_order: 1,
};

const SETTINGS: BillingSettings = {
  payments_required: true,
  cbe_enabled: true,
  cbe_account_number: '1000123459660',
  cbe_account_name: 'Snowfall Technologies PLC',
  telebirr_enabled: true,
  telebirr_phone: '0912345678',
  telebirr_account_name: 'Snowfall Technologies',
  currency: 'ETB',
  receipt_max_age_days: 7,
  grace_days: 0,
  instructions: null,
};

// Fixed "now": 2026-08-12 10:00 local.
const NOW = new Date(2026, 7, 12, 10, 0, 0);
const yesterday = new Date(NOW.getTime() - 86_400_000);

function receipt(overrides: Partial<CheckInput['receipt']> = {}) {
  return {
    reference: 'FT25174XNRV0',
    amount: 1200,
    currency: 'ETB',
    payerName: 'ABEBE BEKELE',
    payerAccount: '1000987654321',
    receiverName: 'Snowfall Technologies PLC',
    receiverAccount: '1000123459660',
    reason: 'K7M2QP',
    status: 'Completed',
    date: yesterday,
    declaredSuccess: true,
    ...overrides,
  };
}

function check(overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    receipt: receipt(),
    reasonCode: 'K7M2QP',
    plan: PLAN,
    selectedCycle: 'MONTHLY',
    provider: 'CBE',
    settings: SETTINGS,
    now: NOW,
    ...overrides,
  };
}

const byKey = (checks: PaymentCheck[], key: string) => checks.find((c) => c.key === key);

/* ------------------------------------------------------------------ */
/* masked account matching                                             */
/* ------------------------------------------------------------------ */

describe('matchAccount', () => {
  it('matches an unmasked account on its trailing digits', () => {
    expect(matchAccount('1000123459660', '1000123459660', 'account')).toBe(true);
  });

  it('rejects a genuinely different account', () => {
    expect(matchAccount('1000987654321', '1000123459660', 'account')).toBe(false);
  });

  it('matches a same-length masked account in place, using the leading digits too', () => {
    expect(matchAccount('1000*****9660', '1000123459660', 'account')).toBe(true);
    // same mask, contradicting visible prefix
    expect(matchAccount('2000*****9660', '1000123459660', 'account')).toBe(false);
  });

  it('matches a different-length masked value on its trailing visible run', () => {
    expect(matchAccount('****9660', '1000123459660', 'account')).toBe(true);
    expect(matchAccount('****1234', '1000123459660', 'account')).toBe(false);
  });

  it('returns null when fewer than four digits are visible (warn, never reject)', () => {
    expect(matchAccount('*****660', '1000123459660', 'account')).toBeNull();
  });

  it('does not count the 251 country code as evidence', () => {
    // 2519******** discloses one real digit and would otherwise match every
    // Ethiopian mobile on the network
    expect(matchAccount('2519********', '0912345678', 'phone')).toBeNull();
    expect(matchAccount('251912******', '0912345678', 'phone')).toBeNull(); // only 912 disclosed
    expect(matchAccount('2519123*****', '0912345678', 'phone')).toBe(true); // 9123 — enough
  });

  it('returns null when either side is missing', () => {
    expect(matchAccount(null, '1000123459660', 'account')).toBeNull();
    expect(matchAccount('1000123459660', null, 'account')).toBeNull();
  });

  it('canonicalises phone numbers across 09…, 9… and +2519… forms', () => {
    expect(matchAccount('0912345678', '912345678', 'phone')).toBe(true);
    expect(matchAccount('+251912345678', '0912345678', 'phone')).toBe(true);
    expect(matchAccount('251912345678', '0912345678', 'phone')).toBe(true);
    expect(matchAccount('0911111111', '0912345678', 'phone')).toBe(false);
  });

  it('canonicalises masked phone numbers too — the real wallet receipt shape', () => {
    // a genuine Telebirr receipt prints the receiver as 2519****5678
    expect(matchAccount('2519****5678', '0912345678', 'phone')).toBe(true);
    expect(matchAccount('2519****9660', '0912345678', 'phone')).toBe(false);
  });

  it('treats x and X as mask glyphs', () => {
    expect(matchAccount('1000xxxxx9660', '1000123459660', 'account')).toBe(true);
  });
});

describe('namesLookAlike', () => {
  it('matches either direction after normalising', () => {
    expect(namesLookAlike('SNOWFALL TECHNOLOGIES PLC', 'Snowfall Technologies')).toBe(true);
    expect(namesLookAlike('Snowfall Technologies', 'snowfall-technologies plc')).toBe(true);
  });
  it('does not match unrelated names', () => {
    expect(namesLookAlike('Abebe Bekele', 'Snowfall Technologies')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* receipt normalisation                                               */
/* ------------------------------------------------------------------ */

describe('normalise', () => {
  it('prefers the settled amount over the fee-inclusive total', () => {
    // checking the larger figure would let an underpayment through
    expect(normalise({ settledAmount: 1500, totalPaidAmount: 1520 }).amount).toBe(1500);
    expect(normalise({ totalPaidAmount: 1520, settledAmount: 1500 }).amount).toBe(1500);
  });

  it('falls back down the alias list when the preferred field is absent', () => {
    expect(normalise({ totalPaidAmount: 1520 }).amount).toBe(1520);
  });

  it('flattens nested data.* without clobbering top-level keys', () => {
    const r = normalise({ reference: 'TOP', data: { reference: 'NESTED', payerName: 'ABEBE' } });
    expect(r.reference).toBe('TOP');
    expect(r.payerName).toBe('ABEBE');
  });

  it('is case- and separator-insensitive about key names', () => {
    expect(normalise({ Payer_Name: 'ABEBE' }).payerName).toBe('ABEBE');
    expect(normalise({ 'credited-party-account-no': '1000***9660' }).receiverAccount).toBe('1000***9660');
  });

  it('reads the declared success flag as a tri-state', () => {
    expect(normalise({ success: true, amount: 1 }).declaredSuccess).toBe(true);
    expect(normalise({ success: false, amount: 1 }).declaredSuccess).toBe(false);
    // no flag at all must not be reported to the payer as a failure
    expect(normalise({ amount: 1 }).declaredSuccess).toBeNull();
  });
});

describe('parseAmount', () => {
  it('strips currency text and thousands separators', () => {
    expect(parseAmount('1,500.00 ETB')).toBe(1500);
    expect(parseAmount('ETB 1500')).toBe(1500);
    expect(parseAmount(1500.5)).toBe(1500.5);
  });
  it('returns null for unusable input', () => {
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount('n/a')).toBeNull();
  });
});

describe('parseReceiptDate', () => {
  it('reads day-first dates correctly when the day is <= 12', () => {
    // the silent-corruption case: a generic parser reads this as 8 January
    const d = parseReceiptDate('01/08/2026');
    expect(d?.getDate()).toBe(1);
    expect(d?.getMonth()).toBe(7); // August
    expect(d?.getFullYear()).toBe(2026);
  });

  it('reads day-first dates when the day is > 12', () => {
    const d = parseReceiptDate('25/12/2026');
    expect(d?.getDate()).toBe(25);
    expect(d?.getMonth()).toBe(11);
  });

  it('reads day-first with a time and with dashes', () => {
    const d = parseReceiptDate('01/08/2026 14:35:07');
    expect(d?.getDate()).toBe(1);
    expect(d?.getMonth()).toBe(7);
    expect(d?.getHours()).toBe(14);
    expect(d?.getMinutes()).toBe(35);
    expect(parseReceiptDate('01-08-26')?.getMonth()).toBe(7);
  });

  it('handles 12-hour times with a meridiem', () => {
    expect(parseReceiptDate('01/08/2026 02:00 PM')?.getHours()).toBe(14);
    expect(parseReceiptDate('01/08/2026 12:00 AM')?.getHours()).toBe(0);
  });

  it('rejects impossible day-first dates rather than rolling them over', () => {
    expect(parseReceiptDate('31/02/2026')).toBeNull();
  });

  it('reads epoch seconds and milliseconds', () => {
    const seconds = parseReceiptDate(1786000000);
    const millis = parseReceiptDate(1786000000000);
    expect(seconds?.getTime()).toBe(1786000000000);
    expect(millis?.getTime()).toBe(1786000000000);
  });

  it('still handles ISO dates', () => {
    expect(parseReceiptDate('2026-08-01T10:00:00Z')?.getUTCMonth()).toBe(7);
  });
});

/* ------------------------------------------------------------------ */
/* QR payloads                                                         */
/* ------------------------------------------------------------------ */

describe('parsePayload', () => {
  it('splits a CBE receipt URL into reference + account suffix', () => {
    const r = parsePayload('https://apps.cbe.com.et:100/?id=FT25174XNRV064679164');
    expect(r.provider).toBe('CBE');
    expect(r.reference).toBe('FT25174XNRV0');
    expect(r.accountSuffix).toBe('64679164');
  });

  it('passes a CBE short-link through whole and preserves its case', () => {
    const url = 'https://mbreciept.cbe.com.et/v2-hfHCxzxlYzc8nHWc1MJG';
    const r = parsePayload(url);
    expect(r.provider).toBe('CBE');
    expect(r.reference).toBe(url); // the API resolves it to the canonical reference
  });

  it('takes the last path segment of a wallet receipt URL', () => {
    const r = parsePayload('https://transactioninfo.ethiotelecom.et/receipt/CFG12H34IJ');
    expect(r.provider).toBe('TELEBIRR');
    expect(r.reference).toBe('CFG12H34IJ');
  });

  it('accepts a bare reference and upper-cases it only when purely alphanumeric', () => {
    expect(parsePayload('ft25abcd1234').reference).toBe('FT25ABCD1234');
    expect(parsePayload('ft25-abcd-1234').reference).toBe('ft25-abcd-1234');
    expect(parsePayload('short').reference).toBeNull();
  });
});

describe('parseEmvcoTlv', () => {
  const head = '8018000206010291020131' + '8124000A44475034383842514334';
  const validCrc = crc16ccitt(`${head}6304`).toString(16).toUpperCase().padStart(4, '0');

  it('decodes the hex-counted receipt number out of tag 81', () => {
    expect(parseEmvcoTlv(`${head}6304${validCrc}`)).toBe('DGP488BQC4');
  });

  it('accepts the payload base64-wrapped, as wallet QRs actually carry it', () => {
    const b64 = Buffer.from(`${head}6304${validCrc}`, 'ascii').toString('base64');
    expect(parseEmvcoTlv(b64)).toBe('DGP488BQC4');
  });

  it('still parses when the CRC does not match — a wrong reference just comes back "not found"', () => {
    expect(parseEmvcoTlv(`${head}63040000`)).toBe('DGP488BQC4');
  });

  it('refuses a string the TLV entries do not fully account for', () => {
    // this exactness is the structural check that stops arbitrary hex being
    // read as a receipt
    expect(parseEmvcoTlv(`${head}6304${validCrc}FF`)).toBeNull();
    expect(parseEmvcoTlv('DEADBEEFDEADBEEF')).toBeNull();
  });

  it('computes CRC16-CCITT deterministically', () => {
    expect(crc16ccitt('123456789')).toBe(0x29b1);
  });
});

/* ------------------------------------------------------------------ */
/* cycle resolution                                                    */
/* ------------------------------------------------------------------ */

describe('resolveCycle', () => {
  it('grants the best cycle the payment covers', () => {
    expect(resolveCycle(10000, PLAN)).toBe('YEARLY');
    expect(resolveCycle(12000, PLAN)).toBe('YEARLY');
    expect(resolveCycle(1200, PLAN)).toBe('MONTHLY');
    expect(resolveCycle(9999, PLAN)).toBe('MONTHLY');
  });

  it('absorbs the provider’s own rounding with a small tolerance', () => {
    expect(resolveCycle(1199.995, PLAN)).toBe('MONTHLY');
  });

  it('returns null on an underpayment', () => {
    expect(resolveCycle(500, PLAN)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* renewal maths                                                       */
/* ------------------------------------------------------------------ */

describe('computePeriod', () => {
  it('stacks an early renewal onto the remaining time', () => {
    const expiry = new Date(2026, 9, 1); // 1 Oct, still in the future
    const { start, end } = computePeriod(expiry, 'MONTHLY', NOW);
    expect(start.getTime()).toBe(expiry.getTime());
    expect(end.getMonth()).toBe(10); // 1 Nov — not one month from today
    expect(end.getDate()).toBe(1);
  });

  it('starts a late renewal from today, so dead time cannot be bought back', () => {
    const expiry = new Date(2026, 5, 1); // 1 June, already lapsed
    const { start, end } = computePeriod(expiry, 'MONTHLY', NOW);
    expect(start.getTime()).toBe(NOW.getTime());
    expect(end.getMonth()).toBe(8); // 12 Sep
    expect(end.getDate()).toBe(12);
  });

  it('handles a first activation with no existing expiry', () => {
    const { start, end } = computePeriod(null, 'YEARLY', NOW);
    expect(start.getTime()).toBe(NOW.getTime());
    expect(end.getFullYear()).toBe(2027);
    expect(end.getMonth()).toBe(7);
  });

  it('adds a full year for the yearly cycle', () => {
    const { end } = computePeriod(new Date(2026, 9, 1), 'YEARLY', NOW);
    expect(end.getFullYear()).toBe(2027);
    expect(end.getMonth()).toBe(9);
  });
});

/* ------------------------------------------------------------------ */
/* the check engine                                                    */
/* ------------------------------------------------------------------ */

describe('runChecks', () => {
  it('passes a clean receipt', () => {
    const out = runChecks(check());
    expect(out.passed).toBe(true);
    expect(out.failureReason).toBeNull();
    expect(out.grantedCycle).toBe('MONTHLY');
    expect(out.checks.every((c) => c.state !== 'fail')).toBe(true);
  });

  it('reports BOTH failures when a receipt breaks two rules', () => {
    // Short-circuiting here would make the payer send real money again to
    // discover the second problem.
    const out = runChecks(
      check({
        receipt: receipt({ reason: 'MB Transfer', date: new Date(2026, 6, 1) }),
      }),
    );
    expect(out.passed).toBe(false);
    expect(byKey(out.checks, 'reason')?.state).toBe('fail');
    expect(byKey(out.checks, 'date')?.state).toBe('fail');
    // the headline is the first failure, but the whole list travels with it
    expect(out.failureReason).toContain('MB Transfer');
    expect(out.checks.filter((c) => c.state === 'fail')).toHaveLength(2);
  });

  it('distinguishes "no note at all" from "a note without the code"', () => {
    const none = runChecks(check({ receipt: receipt({ reason: null }) }));
    expect(byKey(none.checks, 'reason')?.message).toContain('has no note on it');

    const wrong = runChecks(check({ receipt: receipt({ reason: 'MB Transfer' }) }));
    expect(byKey(wrong.checks, 'reason')?.message).toContain('"MB Transfer"');
  });

  it('matches the code through punctuation and case', () => {
    const out = runChecks(check({ receipt: receipt({ reason: 'ref: k7m-2qp payment' }) }));
    expect(byKey(out.checks, 'reason')?.state).toBe('pass');
  });

  it('omits the status row entirely when the provider gives nothing to test', () => {
    // "this receipt does not show a status" against a good payment reads as a
    // problem — a rule with nothing to test is not a check.
    const out = runChecks(check({ receipt: receipt({ status: null, declaredSuccess: null }) }));
    expect(byKey(out.checks, 'status')).toBeUndefined();
    expect(out.passed).toBe(true);
  });

  it('rejects a body that declares failure on an HTTP 200', () => {
    const out = runChecks(check({ receipt: receipt({ status: null, declaredSuccess: false }) }));
    expect(byKey(out.checks, 'status')?.state).toBe('fail');
    expect(out.passed).toBe(false);
  });

  it('rejects clearly bad transaction states but lets unfamiliar ones through', () => {
    expect(runChecks(check({ receipt: receipt({ status: 'PENDING' }) })).passed).toBe(false);
    expect(runChecks(check({ receipt: receipt({ status: 'Reversed' }) })).passed).toBe(false);
    expect(runChecks(check({ receipt: receipt({ status: 'BOOKED' }) })).passed).toBe(true);
  });

  it('emits receipt:fail and skips the rest when nothing could be read', () => {
    const out = runChecks(check({ receipt: null, receiptError: 'No transaction was found.' }));
    expect(byKey(out.checks, 'receipt')?.state).toBe('fail');
    expect(out.checks.filter((c) => c.state === 'skip')).toHaveLength(5);
    expect(out.failureReason).toBe('No transaction was found.');
    expect(out.grantedCycle).toBeNull();
  });

  it('grants a year when the money covers it, even though monthly was selected', () => {
    const out = runChecks(check({ receipt: receipt({ amount: 10000 }), selectedCycle: 'MONTHLY' }));
    expect(out.passed).toBe(true);
    expect(out.grantedCycle).toBe('YEARLY');
    expect(out.warnings.join(' ')).toContain('yearly');
  });

  it('fails an underpayment and says how much is missing', () => {
    const out = runChecks(check({ receipt: receipt({ amount: 500 }) }));
    expect(byKey(out.checks, 'amount')?.state).toBe('fail');
    expect(byKey(out.checks, 'amount')?.actual).toBe('500.00 ETB');
    expect(out.grantedCycle).toBeNull();
  });

  it('fails when the amount cannot be read at all', () => {
    const out = runChecks(check({ receipt: receipt({ amount: null }) }));
    expect(byKey(out.checks, 'amount')?.state).toBe('fail');
  });

  it('rejects a payment made into a contradicting account', () => {
    const out = runChecks(check({ receipt: receipt({ receiverAccount: '1000987654321' }) }));
    expect(byKey(out.checks, 'destination')?.state).toBe('fail');
    expect(out.passed).toBe(false);
  });

  it('warns rather than rejects when the receiver is unreadable', () => {
    const out = runChecks(
      check({ receipt: receipt({ receiverAccount: null, receiverName: null }) }),
    );
    expect(byKey(out.checks, 'destination')?.state).toBe('warn');
    expect(out.passed).toBe(true); // guarantees 1-4 still stand behind it
    expect(out.warnings.join(' ')).toContain('receiver');
  });

  it('falls through to the receiver name when the account is too masked to judge', () => {
    const out = runChecks(
      check({
        receipt: receipt({ receiverAccount: '*****660', receiverName: 'SNOWFALL TECHNOLOGIES PLC' }),
      }),
    );
    expect(byKey(out.checks, 'destination')?.state).toBe('pass');
  });

  it('accepts a masked receiver account that matches in place', () => {
    const out = runChecks(check({ receipt: receipt({ receiverAccount: '1000*****9660' }) }));
    expect(byKey(out.checks, 'destination')?.state).toBe('pass');
  });

  it('matches a Telebirr receipt on the masked phone number', () => {
    const out = runChecks(
      check({
        provider: 'TELEBIRR',
        receipt: receipt({ receiverAccount: '2519****5678', receiverName: null }),
      }),
    );
    expect(byKey(out.checks, 'destination')?.state).toBe('pass');
  });

  it('rejects a receipt older than the configured maximum', () => {
    const out = runChecks(check({ receipt: receipt({ date: new Date(2026, 6, 1) }) }));
    expect(byKey(out.checks, 'date')?.state).toBe('fail');
    expect(byKey(out.checks, 'date')?.message).toContain('cannot be reused');
  });

  it('rejects a receipt dated in the future, with a day of clock-skew tolerance', () => {
    const skew = new Date(NOW.getTime() + 6 * 3_600_000); // 6 hours ahead
    expect(runChecks(check({ receipt: receipt({ date: skew }) })).passed).toBe(true);

    const future = new Date(NOW.getTime() + 5 * 86_400_000);
    const out = runChecks(check({ receipt: receipt({ date: future }) }));
    expect(byKey(out.checks, 'date')?.state).toBe('fail');
  });

  it('warns rather than rejects when the date cannot be read', () => {
    const out = runChecks(check({ receipt: receipt({ date: null }) }));
    expect(byKey(out.checks, 'date')?.state).toBe('warn');
    expect(out.passed).toBe(true);
  });

  it('skips the amount rule when no plan is configured', () => {
    const out = runChecks(check({ plan: null }));
    expect(byKey(out.checks, 'amount')?.state).toBe('skip');
    expect(out.grantedCycle).toBeNull();
  });
});
