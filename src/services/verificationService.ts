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

/**
 * Veritas exposes one dedicated route per provider alongside a universal
 * `/verify` that sniffs the provider from the reference shape. We always know
 * which provider issued the receipt — the QR payload says so — and the
 * dedicated routes take the provider-specific parameters, so guessing is not
 * something we need the API to do for us.
 *
 * Note the universal route calls the CBE account suffix `suffix`, whereas the
 * dedicated `/verify-cbe` route calls it `accountSuffix` — which is the name
 * the request body below already uses. Switching to `/verify` would mean
 * renaming that field.
 */
const PROVIDER_PATH: Record<Exclude<BillingProvider, 'CASH'>, string> = {
  CBE: '/verify-cbe',
  TELEBIRR: '/verify-telebirr',
};

/**
 * What a payer is told when the failure is ours, not theirs. It must not ask
 * them to re-check a reference that was already correct, and it must say the
 * money is safe — the commonest reaction to a failed verification is to pay a
 * second time.
 */
const MISCONFIGURED =
  'Receipt verification is not set up correctly on the server, so this receipt could not be checked. ' +
  'Your payment has not been lost — please contact support.';

/**
 * Transport failures that will never come good on a retry, because they mean
 * the address is wrong rather than the network being briefly unhappy.
 * `EAI_AGAIN` is deliberately absent: it is DNS saying "ask again later".
 */
const UNREACHABLE = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/** undici buries the OS-level code one level down, in `cause`. */
function errorCode(err: unknown): string {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code ?? (err as Error)?.name ?? 'UNKNOWN';
}

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
        // x-api-key ONLY. The provider documents that `Authorization: Bearer`
        // is not supported, and sending it as well is the kind of thing a
        // gateway rejects outright.
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-api-key': env.verification.apiKey,
        },
        body,
        signal: AbortSignal.timeout(env.verification.timeoutMs),
      });
    } catch (err) {
      lastStatus = 0;
      const code = errorCode(err);

      // A host that does not resolve, refuses the connection, or serves a
      // certificate for someone else is OUR configuration being wrong. No
      // number of retries fixes it, and "check your connection" sends a gym
      // owner off to debug their wifi over a hostname we got wrong.
      if (UNREACHABLE.has(code)) {
        console.error(
          `[verify] cannot reach ${url} (${code}). VERIFY_API_URL is wrong or the host is down.`,
        );
        return { ok: false, receipt: null, error: MISCONFIGURED, status: 0, raw: null };
      }

      lastError =
        (err as Error).name === 'TimeoutError'
          ? 'The verification service took too long to respond. Try again in a moment.'
          : 'Could not reach the verification service. Try again in a moment.';
      console.warn(`[verify] transport error on ${url} (attempt ${attempt + 1}) [${code}]:`, (err as Error).message);
      continue; // genuinely transient — worth another go
    }

    lastStatus = res.status;
    const { json: raw, text, isJson } = await readBody(res);

    if (res.status >= 500 || res.status === 429) {
      lastError = messageFor(res.status, raw);
      continue;
    }

    // A 4xx whose body is not JSON is not the bank talking — it is a web
    // server or a proxy, which means the URL we called is wrong, not the
    // receipt. Reporting that through messageFor() turns a 404 on a mistyped
    // path into "no transaction was found with that reference", which blames
    // the payer for our own misconfiguration and sends them off to re-check a
    // reference that was correct all along.
    if (!res.ok && !isJson) {
      console.error(
        `[verify] non-JSON ${res.status} from ${url} ` +
          `(content-type: ${res.headers.get('content-type') ?? 'none'}): ${(text ?? '').slice(0, 200)}`,
      );
      return { ok: false, receipt: null, error: MISCONFIGURED, status: res.status, raw: null };
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

/**
 * Read the body once, and report whether it was actually JSON.
 *
 * `isJson` is the part that matters: it separates "the bank answered and said
 * no" from "something that is not the bank answered at all". `res.json()`
 * alone collapses both into null and loses that distinction.
 *
 * The content-type header is a hint, not the rule — some gateways serve JSON
 * as text/plain — so a body that starts with `{` or `[` is parsed regardless.
 */
async function readBody(res: Response): Promise<{ json: unknown; text: string | null; isJson: boolean }> {
  const text = await res.text().catch(() => '');
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('json') || /^\s*[[{]/.test(text)) {
    try {
      return { json: JSON.parse(text), text, isJson: true };
    } catch {
      // Claimed JSON, wasn't. Fall through and treat it as an opaque body.
    }
  }
  return { json: null, text, isJson: false };
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
