import { Bot } from 'grammy';
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
 */

interface BotEntry {
  bot: Bot;
  username: string;
  gymId: number;
}

const bots = new Map<number, BotEntry>();
const startErrors = new Map<number, string>();

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
    configured: entry !== undefined || startErrors.has(gymId),
    running: entry !== undefined,
    username: entry?.username ?? null,
    error: startErrors.get(gymId) ?? null,
  };
}

export async function startBotForGym(gymId: number, token: string, gymName: string): Promise<void> {
  await stopBot(gymId);
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
    // long polling runs until stop(); don't await
    void bot.start({ drop_pending_updates: true }).catch((err: Error) => {
      // eslint-disable-next-line no-console
      console.error(`[telegram] gym ${gymId} polling stopped:`, err.message);
      bots.delete(gymId);
      startErrors.set(gymId, err.message);
    });
    // eslint-disable-next-line no-console
    console.log(`[telegram] gym ${gymId} bot @${me.username} started`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid token';
    startErrors.set(gymId, message);
    // eslint-disable-next-line no-console
    console.error(`[telegram] gym ${gymId} bot failed to start: ${message}`);
  }
}

export async function stopBot(gymId: number): Promise<void> {
  const entry = bots.get(gymId);
  if (!entry) return;
  bots.delete(gymId);
  try {
    await entry.bot.stop();
  } catch {
    /* already stopped */
  }
}

/** Called on settings save when the token changed. */
export async function restartBot(gymId: number, token: string | null): Promise<void> {
  if (!token) {
    startErrors.delete(gymId);
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
