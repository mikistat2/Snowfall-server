import { Bot, GrammyError } from 'grammy';
import * as gymModel from '../models/gymModel';
import * as memberModel from '../models/memberModel';
import * as subscriptionModel from '../models/subscriptionModel';
import * as userModel from '../models/userModel';
import * as occupancyService from '../services/occupancyService';
import { dateOnly, daysBetween } from '../utils/dates';
import * as templates from './templates';

/**
 * One grammY bot per gym (each gym supplies its own bot token in settings),
 * long-polling. Handles:
 *   /start <token>  — one-time deep-link binding for members ("m<token>")
 *                     and owners/staff ("a<token>")
 *   /days           — the asking member's remaining membership days
 *   /traffic        — current occupancy + quiet/moderate/busy label
 *
 * Telegram allows only ONE getUpdates poll per token. If another instance is
 * polling the same token (e.g. a second deploy, or an old instance still
 * shutting down) we get a 409 Conflict and polling stops. Instead of giving up,
 * we retry with exponential backoff, so the surviving instance reconnects
 * automatically once the token is free again — no redeploy needed.
 */

interface BotEntry {
  bot: Bot;
  username: string;
  gymId: number;
}

/** A gym that SHOULD be running (intent), so retries know whether to continue. */
interface Desired {
  token: string;
  gymName: string;
}

const bots = new Map<number, BotEntry>();
const startErrors = new Map<number, string>();
const desired = new Map<number, Desired>();
const retryTimers = new Map<number, NodeJS.Timeout>();
const retryAttempts = new Map<number, number>();

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

export function getBot(gymId: number): BotEntry | undefined {
  return bots.get(gymId);
}

/**
 * True when at least one gym has a running bot.
 *
 * Read from memory, never the database — which is the point. Every
 * Telegram-driven cron job opens with `gymModel.listAll()` before it can
 * discover that no gym has a bot, and on an autosuspending provider that query
 * alone wakes the compute
 * and resets its suspend timer. On a deployment where nobody uses Telegram,
 * checking here skips those jobs without touching Postgres at all.
 */
export function hasAnyBot(): boolean {
  return bots.size > 0;
}

export function getStatus(gymId: number): {
  configured: boolean;
  running: boolean;
  username: string | null;
  error: string | null;
} {
  const entry = bots.get(gymId);
  return {
    configured: entry !== undefined || startErrors.has(gymId) || desired.has(gymId),
    running: entry !== undefined,
    username: entry?.username ?? null,
    error: startErrors.get(gymId) ?? null,
  };
}

/** Stop the live bot but keep the "desired" intent (so retries continue). */
async function stopRunning(gymId: number): Promise<void> {
  const entry = bots.get(gymId);
  if (!entry) return;
  bots.delete(gymId);
  try {
    await entry.bot.stop();
  } catch {
    /* already stopped */
  }
}

function cancelRetry(gymId: number): void {
  const timer = retryTimers.get(gymId);
  if (timer) {
    clearTimeout(timer);
    retryTimers.delete(gymId);
  }
  retryAttempts.delete(gymId);
}

function scheduleRetry(gymId: number): void {
  if (retryTimers.has(gymId)) return; // one pending retry at a time
  const attempt = (retryAttempts.get(gymId) ?? 0) + 1;
  retryAttempts.set(gymId, attempt);
  const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
  // eslint-disable-next-line no-console
  console.log(`[telegram] gym ${gymId} will reconnect in ${delay / 1000}s (attempt ${attempt})`);
  const timer = setTimeout(() => {
    retryTimers.delete(gymId);
    const want = desired.get(gymId);
    if (want) void startBotForGym(gymId, want.token, want.gymName);
  }, delay);
  retryTimers.set(gymId, timer);
}

function handleFailure(gymId: number, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  bots.delete(gymId);
  startErrors.set(gymId, message);

  // A 401 means the token itself is wrong — retrying can never fix that.
  if (err instanceof GrammyError && err.error_code === 401) {
    // eslint-disable-next-line no-console
    console.error(`[telegram] gym ${gymId} invalid token — not retrying: ${message}`);
    cancelRetry(gymId);
    return;
  }

  // 409 (conflict) or a network blip — keep trying while this gym is desired.
  // eslint-disable-next-line no-console
  console.error(`[telegram] gym ${gymId} polling stopped: ${message}`);
  if (desired.has(gymId)) scheduleRetry(gymId);
}

export async function startBotForGym(gymId: number, token: string, gymName: string): Promise<void> {
  desired.set(gymId, { token, gymName }); // record intent BEFORE any await
  await stopRunning(gymId);
  startErrors.delete(gymId);

  const bot = new Bot(token);

  bot.command('start', async (ctx) => {
    const payload = (ctx.match ?? '').trim();
    const chatId = ctx.chat.id;

    if (payload.startsWith('m')) {
      const member = await memberModel.findByLinkToken(payload.slice(1));
      if (member && member.gym_id === gymId) {
        await memberModel.bindTelegram(member.id, chatId, ctx.from?.username ?? null);
        await ctx.reply(templates.linkedWelcome(member.full_name, gymName));
        return;
      }
    } else if (payload.startsWith('a')) {
      const user = await userModel.findByLinkToken(payload.slice(1));
      if (user && user.gym_id === gymId) {
        await userModel.bindTelegram(user.id, chatId);
        await ctx.reply(templates.adminLinkedWelcome(user.name, gymName));
        return;
      }
    }

    await ctx.reply(
      `👋 Welcome to ${gymName}! Ask the front desk for your personal link to connect your membership.`,
    );
  });

  bot.command('traffic', async (ctx) => {
    const count = await occupancyService.getOccupancy(gymId);
    await ctx.reply(templates.trafficReply(count, templates.trafficLabel(count)));
  });

  /**
   * How many days a member has left — the pull counterpart to the expiry
   * reminders we push.
   *
   * Days are counted with the same `daysBetween(today, expires_at)` the
   * reminder job uses, so a member who asks on the morning of a reminder is
   * told the same number the reminder will tell them.
   *
   * A frozen membership reports its saved days rather than a countdown: the
   * expiry date is still in the row but is not running down, and quoting it
   * would tell someone their frozen membership is expiring.
   */
  bot.command('days', async (ctx) => {
    const member = await memberModel.findByTelegramChatId(gymId, ctx.chat.id);
    if (!member) {
      await ctx.reply(templates.daysLeftNotLinked(gymName));
      return;
    }

    const sub = await subscriptionModel.findCurrentWithPlan(member.id);
    if (!sub) {
      await ctx.reply(templates.daysLeftNoSubscription(member.full_name, gymName));
      return;
    }

    const gym = await gymModel.findById(gymId);
    const graceDays = gym ? gymModel.getSettings(gym).grace_period_days : 0;
    const daysLeft = daysBetween(dateOnly(new Date()), sub.expires_at);

    if (sub.status === 'frozen') {
      // Frozen stores the remaining allowance explicitly; fall back to the
      // date only if an older row predates that column being filled in.
      await ctx.reply(
        templates.daysLeftReply(
          member.full_name,
          Math.max(sub.frozen_days_remaining ?? daysLeft, 0),
          gymName,
          'frozen',
        ),
      );
      return;
    }

    if (daysLeft < 0) {
      await ctx.reply(
        templates.daysLeftReply(member.full_name, 0, gymName, 'grace', Math.max(graceDays + daysLeft, 0)),
      );
      return;
    }

    await ctx.reply(templates.daysLeftReply(member.full_name, daysLeft, gymName, 'active'));
  });

  bot.catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[telegram] gym ${gymId} bot error:`, err.message);
  });

  try {
    const me = await bot.api.getMe();
    // Registered before any further network call. `hasAnyBot()` reads this map
    // to decide whether the daily batch has anyone to message, so every
    // round-trip between here and the insert is a window in which a cold-start
    // batch concludes there are no bots and skips the day.
    bots.set(gymId, { bot, username: me.username, gymId });
    // Populates Telegram's own "/" menu, which is the only way a member finds
    // out these exist — nothing in the app tells them. Not awaited, and
    // best-effort: a failure costs discoverability, not function.
    void bot.api
      .setMyCommands([
        { command: 'days', description: 'How many days are left on your membership' },
        { command: 'traffic', description: 'How busy the gym is right now' },
      ])
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`[telegram] gym ${gymId} setMyCommands failed:`, (err as Error).message);
      });
    cancelRetry(gymId); // connected cleanly — reset backoff
    // long polling runs until stop(); don't await. On failure, retry.
    void bot.start({ drop_pending_updates: true }).catch((err: unknown) => {
      handleFailure(gymId, err);
    });
    // eslint-disable-next-line no-console
    console.log(`[telegram] gym ${gymId} bot @${me.username} started`);
  } catch (err) {
    handleFailure(gymId, err);
  }
}

/** External stop: clears intent and any pending retry, then stops the bot. */
export async function stopBot(gymId: number): Promise<void> {
  desired.delete(gymId);
  startErrors.delete(gymId);
  cancelRetry(gymId);
  await stopRunning(gymId);
}

/** Called on settings save when the token changed. */
export async function restartBot(gymId: number, token: string | null): Promise<void> {
  if (!token) {
    await stopBot(gymId);
    return;
  }
  const gym = await gymModel.findById(gymId);
  // A stored token is not permission to run. Checked here as well as at the
  // settings route because a token can predate the revocation.
  if (gym && !gym.telegram_allowed) {
    await stopBot(gymId);
    return;
  }
  await startBotForGym(gymId, token, gym?.name ?? 'your gym');
}

/** Boot: start bots for every gym that has a token configured *and allowed*. */
/**
 * The startup pass, exposed so callers can wait for it.
 *
 * Starts resolved: before boot has called `initBots` there is nothing to wait
 * for, and a caller must never block on a pass that will never run.
 */
let startupPass: Promise<void> = Promise.resolve();

export function initBots(): Promise<void> {
  startupPass = (async () => {
    const gyms = await gymModel.listAll();
    for (const gym of gyms) {
      if (gym.telegram_bot_token && gym.telegram_allowed) {
        await startBotForGym(gym.id, gym.telegram_bot_token, gym.name);
      }
    }
  })();
  return startupPass;
}

/**
 * Resolves once every gym's bot has been registered (or the pass gave up).
 *
 * `hasAnyBot()` reads an in-memory map that `initBots` fills one gym at a time,
 * each behind a network round-trip to Telegram. Boot does not await that pass
 * before it starts listening, so a request arriving on a cold instance — which
 * is precisely when the external scheduler's POST /tasks/daily arrives — can
 * read the map while it is still empty, conclude no gym has a bot, and skip
 * every member message for a day that is already claimed.
 *
 * The timeout is the point: a Telegram API that is slow or unreachable must
 * delay the batch, never strand it. Resolving instead of rejecting on timeout
 * means the caller carries on with whatever registered in time, which is the
 * same outcome as before this existed.
 */
export function whenBotsReady(timeoutMs = 30_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    // Never hold the process open on this alone.
    timer.unref();
  });
  // The rejection is already handled where initBots was called; swallowing it
  // here keeps a failed pass from turning into a second unhandled rejection.
  return Promise.race([startupPass.catch(() => undefined), deadline]).finally(() =>
    clearTimeout(timer),
  );
}
