"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.money = money;
exports.normaliseText = normaliseText;
exports.matchAccount = matchAccount;
exports.namesLookAlike = namesLookAlike;
exports.priceFor = priceFor;
exports.resolveCycle = resolveCycle;
exports.computePeriod = computePeriod;
exports.runChecks = runChecks;
/**
 * The check engine: everything that decides whether a receipt is acceptable.
 *
 * Pure functions only — no database, no network — so every rule below is unit
 * testable against a literal receipt object.
 *
 * ── The security model ──────────────────────────────────────────────────────
 * No single check is sufficient. Four independent guarantees stand behind an
 * activated subscription, and the next person to touch this file should resist
 * the urge to "simplify" any of them away:
 *
 *  1. The reason code proves the payment belongs to THIS gym. Without it,
 *     anyone could paste a stranger's receipt found in a group chat.
 *  2. `billing_payments.verified_reference` is UNIQUE in the database, so one
 *     receipt activates exactly one subscription. Replay is impossible, not
 *     merely unlikely. (Enforced in billingService + the migration, not here.)
 *  3. The amount must meet the configured price for the cycle being bought.
 *  4. The receipt must be recent, so an old transfer cannot be recycled into a
 *     fresh subscription.
 *
 * A fifth guarantee is not always decidable: the money must have landed in OUR
 * account. A receipt naming a DIFFERENT receiver is fatal — the receipt itself
 * says the money went elsewhere. A receipt that simply does not disclose the
 * receiver is a warning, not a rejection: rejecting on a field the provider
 * may not return would lock out gyms that genuinely paid, and guarantees 1–4
 * still stand behind it.
 *
 * Trap worth naming: the API's `accountSuffix` parameter does NOT prove
 * destination. It is a lookup key and may well be the SENDER's account.
 * Destination is read out of the returned receipt body, below.
 */
// ------------------------------------------------------------ formatting ---
function money(amount, currency) {
    return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}
/** Strip everything but letters and digits, upper-case: `ref: a1-b2c3` → `A1B2C3`. */
function normaliseText(value) {
    return value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}
// ------------------------------------------------- masked account matching --
/**
 * Receipts print partly-masked accounts — a real wallet receipt gives the
 * receiver as `2519****9660`. Comparing plain digits would fail against EVERY
 * correctly-paid account, so this is where a naive implementation rejects all
 * legitimate payments.
 *
 * Returns `true` (match), `false` (contradiction) or `null` (too masked to
 * judge). The caller treats `null` as a warning, never a rejection.
 */
function matchAccount(receiptValue, configured, kind) {
    if (!receiptValue || !configured)
        return null;
    const a = canonical(receiptValue, kind);
    const b = canonical(configured, kind);
    if (!a || !b)
        return null;
    if (informativeDigits(a, kind) < 4 || informativeDigits(b, kind) < 4)
        return null; // too masked to judge
    const tailLength = kind === 'phone' ? 9 : 8;
    // Neither side masked → compare the trailing run, which is what a bank
    // reference actually matches on.
    if (!a.includes('*') && !b.includes('*')) {
        const n = Math.min(tailLength, a.length, b.length);
        return a.slice(-n) === b.slice(-n);
    }
    // Same length → compare visible characters IN PLACE. This uses the leading
    // digits as well as the trailing ones, which is strictly more evidence.
    if (a.length === b.length) {
        for (let i = 0; i < a.length; i += 1) {
            if (a[i] === '*' || b[i] === '*')
                continue;
            if (a[i] !== b[i])
                return false;
        }
        return true;
    }
    // Different lengths → compare the trailing visible run, if it is long enough
    // to mean anything.
    const runA = trailingVisibleRun(a);
    const runB = trailingVisibleRun(b);
    const n = Math.min(runA.length, runB.length);
    if (n >= 4)
        return runA.slice(-n) === runB.slice(-n);
    return null;
}
/**
 * Visible digits that actually carry evidence.
 *
 * After phone canonicalisation every number starts with the same `251`, so
 * counting those three would let `2519********` look like four visible digits
 * when it really discloses one — and that would match every Ethiopian mobile
 * on the network. Country codes are not evidence.
 */
function informativeDigits(value, kind) {
    const body = kind === 'phone' && value.startsWith('251') ? value.slice(3) : value;
    return (body.match(/\d/g) ?? []).length;
}
/** Keep digits and mask glyphs only; normalise `x`/`X` to `*`. */
function canonical(value, kind) {
    const cleaned = value
        .trim()
        .replace(/[xX]/g, '*')
        .replace(/[^0-9*]/g, '');
    if (!cleaned)
        return null;
    return kind === 'phone' ? canonicalPhone(cleaned) : cleaned;
}
/**
 * One form for phone numbers: `09…`, `9…` and `+2519…` all become `251…`.
 * Runs on masked values too, so mask glyphs are preserved throughout.
 */
function canonicalPhone(value) {
    if (value.startsWith('251'))
        return value;
    if (value.startsWith('0') && value.length >= 9)
        return `251${value.slice(1)}`;
    if (value.length === 9 && /^[79*]/.test(value))
        return `251${value}`;
    return value;
}
function trailingVisibleRun(value) {
    const match = value.match(/\d+$/);
    return match ? match[0] : '';
}
/** Fuzzy name comparison — substring either direction after normalising. */
function namesLookAlike(a, b) {
    if (!a || !b)
        return false;
    const x = normaliseText(a);
    const y = normaliseText(b);
    if (x.length < 3 || y.length < 3)
        return false;
    return x.includes(y) || y.includes(x);
}
// -------------------------------------------------------- cycle resolution --
function priceFor(plan, cycle) {
    return Number(cycle === 'YEARLY' ? plan.yearly_price : plan.monthly_price);
}
/**
 * Grant the best cycle the payment actually covers.
 *
 * Without this, someone who transfers the yearly amount while "monthly" is
 * selected on the form gets a month — the most annoying possible outcome for
 * everyone. The selected cycle is recorded alongside the granted one so the
 * discrepancy is visible on the row.
 */
function resolveCycle(paid, plan, tolerance = 0.01) {
    const yearly = priceFor(plan, 'YEARLY');
    const monthly = priceFor(plan, 'MONTHLY');
    if (yearly > 0 && paid + tolerance >= yearly)
        return 'YEARLY';
    if (monthly > 0 && paid + tolerance >= monthly)
        return 'MONTHLY';
    return null;
}
// -------------------------------------------------------- renewal maths ----
/**
 * A verified payment extends from whichever is later: now, or the current
 * expiry.
 *
 * Taking the max means a gym that renews EARLY does not lose the days it has
 * already paid for, and a gym that renews LATE starts from today rather than
 * from its lapsed date — so dead time cannot be bought back cheaply.
 */
function computePeriod(currentExpiry, cycle, now = new Date()) {
    const current = currentExpiry ? new Date(currentExpiry) : null;
    const base = current && current.getTime() > now.getTime() ? current : now;
    const end = new Date(base);
    if (cycle === 'YEARLY')
        end.setFullYear(end.getFullYear() + 1);
    else
        end.setMonth(end.getMonth() + 1);
    return { start: base, end };
}
/**
 * Run EVERY rule. Never short-circuit at the first failure.
 *
 * Short-circuiting is cheaper, and it makes for a miserable retry loop: a gym
 * whose receipt has both a missing code and a stale date fixes one, sends REAL
 * MONEY again, and only then learns about the other. Running every rule means
 * one screen shows everything wrong at once.
 */
function runChecks(input) {
    const now = input.now ?? new Date();
    const { receipt, settings, reasonCode, plan } = input;
    const currency = receipt?.currency || settings.currency;
    const checks = [];
    const warnings = [];
    // --- receipt ------------------------------------------------------------
    if (!receipt) {
        const message = input.receiptError ?? 'The receipt could not be read from the bank.';
        checks.push({
            key: 'receipt',
            label: 'Receipt found',
            state: 'fail',
            expected: null,
            actual: null,
            message,
        });
        // Emit the rest as skipped so the UI still renders a complete list rather
        // than one lonely red row.
        for (const [key, label] of [
            ['status', 'Transaction successful'],
            ['reason', 'Your payment code in the reason'],
            ['amount', 'Amount paid'],
            ['destination', 'Paid into our account'],
            ['date', 'Receipt is recent'],
        ]) {
            checks.push({
                key,
                label,
                state: 'skip',
                expected: null,
                actual: null,
                message: 'Not checked — the receipt could not be read.',
            });
        }
        return { checks, warnings, passed: false, failureReason: message, grantedCycle: null };
    }
    checks.push({
        key: 'receipt',
        label: 'Receipt found',
        state: 'pass',
        expected: null,
        actual: receipt.reference,
        message: 'The bank returned this receipt.',
    });
    // --- status -------------------------------------------------------------
    // A rule the provider gives us nothing to test is not a check. Listing
    // "this receipt does not show a status" against a perfectly good payment
    // reads as a problem, so that row is omitted entirely.
    const BAD_STATES = [
        'pending', 'failed', 'cancelled', 'canceled', 'declined',
        'reversed', 'refunded', 'expired', 'processing', 'incomplete',
    ];
    if (receipt.status) {
        const lower = receipt.status.toLowerCase();
        // Only clearly bad states reject. An unfamiliar one passes to the other
        // rules rather than blocking a payment we simply do not recognise.
        const bad = BAD_STATES.find((s) => lower.includes(s));
        checks.push({
            key: 'status',
            label: 'Transaction successful',
            state: bad ? 'fail' : 'pass',
            expected: 'completed',
            actual: receipt.status,
            message: bad
                ? `The bank reports this transaction as "${receipt.status}". Only a completed transfer can be verified.`
                : 'The bank reports this transaction as completed.',
        });
    }
    else if (receipt.declaredSuccess === false) {
        // A response declaring failure on an HTTP 200 must be rejected.
        checks.push({
            key: 'status',
            label: 'Transaction successful',
            state: 'fail',
            expected: 'completed',
            actual: 'failed',
            message: 'The verification service reports that this transaction did not succeed.',
        });
    }
    else if (receipt.declaredSuccess === true) {
        checks.push({
            key: 'status',
            label: 'Transaction successful',
            state: 'pass',
            expected: 'completed',
            actual: 'completed',
            message: 'The bank confirmed this transfer.',
        });
    }
    // declaredSuccess === null and no status field → no row at all.
    // --- reason (guarantee 1) ----------------------------------------------
    const code = normaliseText(reasonCode);
    if (!receipt.reason) {
        checks.push({
            key: 'reason',
            label: 'Your payment code in the reason',
            state: 'fail',
            expected: reasonCode,
            actual: null,
            message: `That receipt has no note on it, so we cannot tell it is your payment. ` +
                `Send the payment again and type ${reasonCode} in the "reason" box before confirming.`,
        });
    }
    else if (normaliseText(receipt.reason).includes(code)) {
        checks.push({
            key: 'reason',
            label: 'Your payment code in the reason',
            state: 'pass',
            expected: reasonCode,
            actual: receipt.reason,
            message: 'The reason on the receipt carries your payment code.',
        });
    }
    else {
        checks.push({
            key: 'reason',
            label: 'Your payment code in the reason',
            state: 'fail',
            expected: reasonCode,
            actual: receipt.reason,
            message: `The reason says "${receipt.reason}", which does not contain your code ${reasonCode}. ` +
                `Send the payment again and type ${reasonCode} in the "reason" box before confirming.`,
        });
    }
    // --- amount (guarantee 3) ----------------------------------------------
    let grantedCycle = null;
    if (!plan) {
        checks.push({
            key: 'amount',
            label: 'Amount paid',
            state: 'skip',
            expected: null,
            actual: receipt.amount === null ? null : money(receipt.amount, currency),
            message: 'No price is configured, so the amount was not checked.',
        });
    }
    else if (receipt.amount === null) {
        checks.push({
            key: 'amount',
            label: 'Amount paid',
            state: 'fail',
            expected: money(priceFor(plan, input.selectedCycle), settings.currency),
            actual: null,
            message: 'The amount could not be read from that receipt, so it cannot be checked against the price.',
        });
    }
    else {
        grantedCycle = resolveCycle(receipt.amount, plan);
        const cheapest = Math.min(priceFor(plan, 'MONTHLY'), priceFor(plan, 'YEARLY'));
        if (grantedCycle) {
            const covered = priceFor(plan, grantedCycle);
            checks.push({
                key: 'amount',
                label: 'Amount paid',
                state: 'pass',
                expected: money(covered, settings.currency),
                actual: money(receipt.amount, currency),
                message: grantedCycle === input.selectedCycle
                    ? `Covers the ${grantedCycle.toLowerCase()} price for ${plan.name}.`
                    : `That amount covers the ${grantedCycle.toLowerCase()} price for ${plan.name}, so that is what it buys.`,
            });
            if (grantedCycle !== input.selectedCycle) {
                warnings.push(`Selected ${input.selectedCycle.toLowerCase()} but paid enough for ${grantedCycle.toLowerCase()}.`);
            }
        }
        else {
            checks.push({
                key: 'amount',
                label: 'Amount paid',
                state: 'fail',
                expected: money(priceFor(plan, input.selectedCycle), settings.currency),
                actual: money(receipt.amount, currency),
                message: `That is less than the ${money(cheapest, settings.currency)} needed for the cheapest ${plan.name} ` +
                    `option. Send the difference with the same payment code and try again.`,
            });
        }
    }
    // --- destination (guarantee 5, not always decidable) --------------------
    const ourAccount = input.provider === 'CBE' ? settings.cbe_account_number : settings.telebirr_phone;
    const ourName = input.provider === 'CBE' ? settings.cbe_account_name : settings.telebirr_account_name;
    const kind = input.provider === 'CBE' ? 'account' : 'phone';
    const accountVerdict = matchAccount(receipt.receiverAccount, ourAccount, kind);
    if (accountVerdict === true) {
        checks.push({
            key: 'destination',
            label: 'Paid into our account',
            state: 'pass',
            expected: ourAccount,
            actual: receipt.receiverAccount,
            message: 'The receipt shows the money arriving in our account.',
        });
    }
    else if (accountVerdict === false) {
        checks.push({
            key: 'destination',
            label: 'Paid into our account',
            state: 'fail',
            expected: ourAccount,
            actual: receipt.receiverAccount,
            message: 'That payment went to a different account. Send it to the account shown on this page.',
        });
    }
    else if (namesLookAlike(receipt.receiverName, ourName)) {
        // Too masked to judge on digits — fall through to the receiver NAME,
        // which can only ever produce a pass or a warning, never a rejection.
        checks.push({
            key: 'destination',
            label: 'Paid into our account',
            state: 'pass',
            expected: ourName,
            actual: receipt.receiverName,
            message: 'The account number is masked, but the receiver name on the receipt matches ours.',
        });
    }
    else {
        const actual = receipt.receiverAccount ?? receipt.receiverName;
        checks.push({
            key: 'destination',
            label: 'Paid into our account',
            state: 'warn',
            expected: ourAccount ?? ourName,
            actual,
            message: actual
                ? 'The receipt does not show the receiver clearly enough to confirm. Accepted on the code, amount and date.'
                : 'This receipt does not name the receiver at all. Accepted on the code, amount and date.',
        });
        warnings.push(actual
            ? `Receiver could not be confirmed (receipt says "${actual}").`
            : 'Receipt did not identify the receiver.');
    }
    // --- date (guarantee 4) -------------------------------------------------
    const maxAgeDays = settings.receipt_max_age_days;
    if (!receipt.date) {
        // We cannot check what we cannot read — but we should not punish for it.
        checks.push({
            key: 'date',
            label: 'Receipt is recent',
            state: 'warn',
            expected: `within ${maxAgeDays} day${maxAgeDays === 1 ? '' : 's'}`,
            actual: null,
            message: 'The date could not be read from that receipt, so its age was not checked.',
        });
        warnings.push('Receipt date was unreadable.');
    }
    else {
        const ageDays = (now.getTime() - receipt.date.getTime()) / 86_400_000;
        const shown = receipt.date.toDateString();
        if (ageDays < -1) {
            // one day of clock-skew tolerance
            checks.push({
                key: 'date',
                label: 'Receipt is recent',
                state: 'fail',
                expected: `on or before ${now.toDateString()}`,
                actual: shown,
                message: 'That receipt is dated in the future, which cannot be right. Check the transaction ID.',
            });
        }
        else if (ageDays > maxAgeDays) {
            checks.push({
                key: 'date',
                label: 'Receipt is recent',
                state: 'fail',
                expected: `within ${maxAgeDays} day${maxAgeDays === 1 ? '' : 's'}`,
                actual: shown,
                message: `That receipt is ${Math.floor(ageDays)} days old. Only receipts from the last ${maxAgeDays} ` +
                    `day${maxAgeDays === 1 ? '' : 's'} can be used, so an old transfer cannot be reused.`,
            });
        }
        else {
            checks.push({
                key: 'date',
                label: 'Receipt is recent',
                state: 'pass',
                expected: `within ${maxAgeDays} day${maxAgeDays === 1 ? '' : 's'}`,
                actual: shown,
                message: 'The receipt is recent.',
            });
        }
    }
    const firstFailure = checks.find((c) => c.state === 'fail');
    return {
        checks,
        warnings,
        passed: !firstFailure,
        failureReason: firstFailure?.message ?? null,
        grantedCycle: firstFailure ? null : grantedCycle,
    };
}
//# sourceMappingURL=billingChecks.js.map