import { env } from '../config/env';
import type { BillingProvider } from '../types';

/**
 * Client for the receipt verification API (CBE and Telebirr transaction
 * lookup), plus normalisation of the provider-specific receipt into one
 * predictable shape.
 *
 * This module holds NO opinion on whether a receipt is acceptable. Whether the
 * amount is enough, whether the money landed in our account, whether the
 * reason carries the gym's code — all of that depends on our settings and
 * lives in billingService. Keeping the two apart is what makes the check
 * engine testable without a network.
 */

export interface NormalisedReceipt {
  reference: string | null;
  amount: number | null;
  currency: string | null;
  payerName: string | null;
  payerAccount: string | null;
  receiverName: string | null;
  receiverAccount: string | null;
  reason: string | null;
  status: string | null;
  date: Date | null;
  /**
   * The provider's own top-level success flag. `null` means it declared
   * neither way — that must never be reported to the payer as a failure.
   */
  declaredSuccess: boolean | null;
}

export interface VerificationEnvelope {
  ok: boolean;
  receipt: NormalisedReceipt | null;
  error: string | null;
  status: number;
  raw: unknown;
}

export function isConfigured(): boolean {
  return Boolean(env.verification.apiKey && env.verification.baseUrl);
}

// ------------------------------------------------------------ HTTP layer ---

const PROVIDER_PATH: Record<Exclude<BillingProvider, 'CASH'>, string> = {
  CBE: '/api/v1/verify/cbe',
  TELEBIRR: '/api/v1/verify/telebirr',
};

export interface LookupInput {
  provider: Exclude<BillingProvider, 'CASH'>;
  reference: string;
  /** Last 8 digits of an involved account, when the QR carried them. */
  accountSuffix?: string | null;
}

/**
 * Look a transaction up with the provider.
 *
 * Retries only transport-level trouble (network error, 5xx, 429). A 4xx is a
 * real answer from the bank — retrying it burns another paid credit for the
 * same result.
 */
export async function lookup(input: LookupInput): Promise<VerificationEnvelope> {
  if (!isConfigured()) {
    return {
      ok: false,
      receipt: null,
      error: 'Receipt verification is not configured on the server.',
      status: 503,
      raw: null,
    };
  }

  const url = `${env.verification.baseUrl}${PROVIDER_PATH[input.provider]}`;
  const body = JSON.stringify({
    reference: input.reference,
    ...(input.accountSuffix ? { accountSuffix: input.accountSuffix } : {}),
  });

  let lastError = 'The verification service did not respond. Try again in a moment.';
  let lastStatus = 0;

  for (let attempt = 0; attempt <= env.verification.retries; attempt += 1) {
    if (attempt > 0) await sleep(400 * attempt);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${env.verification.apiKey}`,
          'x-api-key': env.verification.apiKey,
        },
        body,
        signal: AbortSignal.timeout(env.verification.timeoutMs),
      });
    } catch (err) {
      lastError = 'Could not reach the verification service. Check your connection and try again.';
      lastStatus = 0;
      console.warn(`[verify] transport error (attempt ${attempt + 1}):`, (err as Error).message);
      continue; // transport trouble — worth another go
    }

    lastStatus = res.status;
    const raw = await safeJson(res);

    if (res.status >= 500 || res.status === 429) {
      lastError = messageFor(res.status, raw);
      continue;
    }

    // A 2xx is never proof on its own: some adapters return success:false with
    // HTTP 200. The verdict comes from the status AND the body.
    if (!res.ok || declaredFailure(raw)) {
      return { ok: false, receipt: null, error: messageFor(res.status, raw), status: res.status, raw };
    }

    const receipt = normalise(raw);

    // A 200 carrying nothing identifying is not a verification. Without this,
    // an empty response would activate a subscription.
    if (!receipt.reference && receipt.amount === null) {
      console.warn('[verify] 200 with no reference or amount; response keys:', Object.keys(flatten(raw)).join(','));
      return {
        ok: false,
        receipt: null,
        error: 'The verification service returned an empty receipt. Check the transaction ID and try again.',
        status: res.status,
        raw,
      };
    }

    return { ok: true, receipt, error: null, status: res.status, raw };
  }

  return { ok: false, receipt: null, error: lastError, status: lastStatus, raw: null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Explicit failure declared inside a 2xx body. */
function declaredFailure(raw: unknown): boolean {
  const flat = flatten(raw);
  if ('error' in flat && flat.error) return true;
  for (const key of ['success', 'verified', 'status', 'ok']) {
    const value = flat[key];
    if (value === false) return true;
    if (typeof value === 'string' && ['failed', 'error', 'failure'].includes(value.toLowerCase())) return true;
  }
  return false;
}

/** Prefer the provider's own wording; otherwise a sentence the payer can act on. */
function messageFor(status: number, raw: unknown): string {
  const flat = flatten(raw);
  for (const key of ['error', 'message', 'detail', 'description']) {
    const value = flat[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  switch (status) {
    case 400:
      return 'That transaction ID is not in a format the bank recognises. Check it and try again.';
    case 401:
    case 403:
      return 'Receipt verification is not authorised on the server. Please contact support.';
    case 402:
      return 'The verification service has run out of credit. Please contact support.';
    case 404:
      return 'No transaction was found with that reference. Check the ID and try again.';
    case 409:
      return 'The bank reported a conflict for that transaction. Please contact support.';
    case 422:
      return 'The bank could not process that reference. Check it and try again.';
    case 429:
      return 'Too many verification requests right now. Wait a minute and try again.';
    default:
      return status >= 500
        ? 'The bank’s verification service is temporarily unavailable. Try again in a few minutes.'
        : 'The receipt could not be verified. Check the details and try again.';
  }
}

// --------------------------------------------------------- normalisation ---

/**
 * Merge nested objects (up to depth 3) into one map, lower-casing keys and
 * stripping `_`, `-` and spaces — so `data.payerName`, `result.payer_name` and
 * `PayerName` all become `payername`.
 *
 * A child key never overwrites a value found nearer the top of the response:
 * the shallowest occurrence wins, because that is the provider's own summary.
 */
export function flatten(input: unknown, depth = 0, out: Record<string, unknown> = {}): Record<string, unknown> {
  if (!input || typeof input !== 'object' || depth > 3) return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const slug = key.toLowerCase().replace(/[\s_-]/g, '');
    if (value !== null && typeof value === 'object') {
      if (!Array.isArray(value)) flatten(value, depth + 1, out);
      continue;
    }
    if (!(slug in out)) out[slug] = value;
  }
  return out;
}

const ALIASES = {
  reference: [
    'reference', 'referencenumber', 'referenceno', 'transactionid', 'txnid',
    'transactionreference', 'receiptnumber', 'receiptno', 'invoiceno', 'traceno',
  ],
  payerName: [
    'payer', 'payername', 'sender', 'sendername', 'from', 'fromname', 'debitedfrom',
    'payeraccountname', 'customername', 'accountholder',
  ],
  payerAccount: [
    'payeraccount', 'payeraccountnumber', 'senderaccount', 'fromaccount', 'debitaccount',
    'sourceaccount', 'payerphone', 'payeraccountno', 'senderphone',
  ],
  receiverName: [
    'receiver', 'receivername', 'credited', 'creditedparty', 'creditedpartyname', 'to',
    'toname', 'beneficiary', 'beneficiaryname', 'payeename', 'receiveraccountname', 'merchantname',
  ],
  receiverAccount: [
    'creditedpartyaccountno', 'creditedpartyaccount', 'receiveraccount', 'receiveraccountnumber',
    'receiveraccountno', 'toaccount', 'creditaccount', 'beneficiaryaccount', 'payeeaccount',
    'destinationaccount', 'receiverphone',
  ],
  reason: [
    'customernote', 'reason', 'paymentreason', 'narrative', 'remark', 'remarks', 'description',
    'note', 'notes', 'purpose', 'memo', 'transactionreason', 'bankreason', 'servicetype',
  ],
  status: ['transactionstatus', 'paymentstatus', 'receiptstatus', 'state'],
  currency: ['currency', 'curr', 'currencycode'],
  date: [
    'date', 'paymentdate', 'transactiondate', 'paymenttime', 'transactiontime', 'datetime',
    'time', 'createdat', 'timestamp', 'valuedate', 'receiptdate',
  ],
  /**
   * Order here is a security decision, not cosmetics. A wallet receipt can
   * carry `settledAmount` (what the receiver actually got) alongside
   * `totalPaidAmount` (that plus the sender's fees). Checking the larger
   * figure against our price would let an underpayment through, so the
   * settled figure comes first and fee-inclusive totals come last.
   */
  amount: [
    'settledamount', 'transferredamount', 'creditamount', 'amount', 'transactionamount',
    'amountpaid', 'paidamount', 'debitamount', 'totalpaidamount', 'totalamount',
  ],
} as const;

function pick(flat: Record<string, unknown>, aliases: readonly string[]): unknown {
  for (const alias of aliases) {
    const value = flat[alias];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
}

function pickString(flat: Record<string, unknown>, aliases: readonly string[]): string | null {
  const value = pick(flat, aliases);
  return value === null ? null : String(value).trim() || null;
}

export function normalise(raw: unknown): NormalisedReceipt {
  const flat = flatten(raw);
  return {
    reference: pickString(flat, ALIASES.reference),
    amount: parseAmount(pick(flat, ALIASES.amount)),
    currency: pickString(flat, ALIASES.currency),
    payerName: pickString(flat, ALIASES.payerName),
    payerAccount: pickString(flat, ALIASES.payerAccount),
    receiverName: pickString(flat, ALIASES.receiverName),
    receiverAccount: pickString(flat, ALIASES.receiverAccount),
    reason: pickString(flat, ALIASES.reason),
    status: pickString(flat, ALIASES.status),
    date: parseReceiptDate(pick(flat, ALIASES.date)),
    declaredSuccess: declaredSuccessOf(flat),
  };
}

function declaredSuccessOf(flat: Record<string, unknown>): boolean | null {
  for (const key of ['success', 'verified', 'ok']) {
    const value = flat[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (['true', 'success', 'successful'].includes(lower)) return true;
      if (['false', 'failed', 'error', 'failure'].includes(lower)) return false;
    }
  }
  return null;
}

export function parseAmount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // "1,500.00 ETB" / "ETB 1 500,00" → keep digits, dot and minus
  const cleaned = String(value)
    .replace(/[^\d.,-]/g, '')
    .replace(/,(?=\d{3}\b)/g, '') // thousands separators
    .replace(',', '.');
  // Number('') is 0, which would turn an unreadable amount into a silent
  // zero and report it as an underpayment instead of "could not be read".
  if (!/\d/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Receipts in this market print day-first (`01/08/2026` is 1 August). A
 * generic Date parse reads that as 8 January and does NOT throw — and only
 * when the day is ≤ 12, so it looks correct most of the time and silently
 * corrupts the rest. Explicit day-first formats are therefore tried first, and
 * any parse that leaves trailing input is rejected.
 */
export function parseReceiptDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number' || /^\d{9,}$/.test(String(value).trim())) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const ms = n > 1e11 ? n : n * 1000; // seconds vs milliseconds
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const text = String(value).trim();

  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(text)) {
    const dayFirst = parseDayFirst(text);
    if (dayFirst) return dayFirst;
  }

  const generic = new Date(text);
  return Number.isNaN(generic.getTime()) ? null : generic;
}

/** Longest pattern first, and the whole string must be consumed. */
function parseDayFirst(text: string): Date | null {
  const match = text.match(
    /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(AM|PM|am|pm)?\s*$/,
  );
  if (!match) return null;

  const [, d, m, y, hh, mm, ss, meridiem] = match;
  const day = Number(d);
  const month = Number(m);
  let year = Number(y);
  if (year < 100) year += year < 70 ? 2000 : 1900;
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  let hour = hh ? Number(hh) : 0;
  if (meridiem) {
    const pm = meridiem.toLowerCase() === 'pm';
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }

  const date = new Date(year, month - 1, day, hour, mm ? Number(mm) : 0, ss ? Number(ss) : 0);
  // Reject impossible dates that JS would roll over (31/02 → 3 March).
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}
