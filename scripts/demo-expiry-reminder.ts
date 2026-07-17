import { Api } from 'grammy';
import { db } from '../src/db/knex';
import * as templates from '../src/telegram/templates';

/**
 * Demo: send an expiry reminder to one member through the gym's Telegram bot,
 * exactly like the daily 09:00 cron would (same template, same notification
 * logging). Does NOT change the member's real expiry date.
 *
 * Usage (from the server/ directory):
 *   npx tsx scripts/demo-expiry-reminder.ts --member 35 --days 3
 */

async function main(): Promise<void> {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const memberId = Number(arg('member'));
  const daysLeft = Number(arg('days') ?? 3);
  if (!Number.isInteger(memberId)) throw new Error('Pass --member <id>');

  const member = await db('members').where({ id: memberId }).first();
  if (!member) throw new Error(`Member ${memberId} not found`);
  if (!member.telegram_chat_id) throw new Error(`${member.full_name} has not linked Telegram`);

  const gym = await db('gyms').where({ id: member.gym_id }).first();
  if (!gym?.telegram_bot_token) throw new Error(`Gym ${member.gym_id} has no bot token`);

  const text = templates.expiryReminder(member.full_name, daysLeft, gym.name);
  await new Api(gym.telegram_bot_token).sendMessage(Number(member.telegram_chat_id), text);

  await db('notifications').insert({
    gym_id: gym.id,
    member_id: member.id,
    type: 'expiry_reminder',
    status: 'sent',
    payload: JSON.stringify({ text, days_left: daysLeft, demo: true }),
  });

  // eslint-disable-next-line no-console
  console.log(`Sent expiry reminder (${daysLeft} days) to ${member.full_name} via ${gym.name}'s bot.`);
  await db.destroy();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
