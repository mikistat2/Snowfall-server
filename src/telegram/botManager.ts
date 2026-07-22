import { Bot, GrammyError } from 'grammy';
import * as gymModel from '../models/gymModel';
import * as memberModel from '../models/memberModel';
import * as userModel from '../models/userModel';
import * as occupancyService from '../services/occupancyService';
import * as templates from './templates';

/**
 * One grammY bot per gym (each gym supplies its own bot token in settings),
 * long-polling. Handles:
 *   /start <token>  — one-time deep-link binding for members ("m<token>")
 *                     and owners/staff ("a<token>")
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

  bot.catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[telegram] gym ${gymId} bot error:`, err.message);
  });

  try {
    const me = await bot.api.getMe();
    bots.set(gymId, { bot, username: me.username, gymId });
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
  await startBotForGym(gymId, token, gym?.name ?? 'your gym');
}

/** Boot: start bots for every gym that has a token configured. */
export async function initBots(): Promise<void> {
  const gyms = await gymModel.listAll();
  for (const gym of gyms) {
    if (gym.telegram_bot_token) {
      await startBotForGym(gym.id, gym.telegram_bot_token, gym.name);
    }
  }
}
