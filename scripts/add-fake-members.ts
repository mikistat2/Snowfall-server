import { db } from '../src/db/knex';

/**
 * Adds fake members (real Ethiopian names) to a gym WITHOUT touching existing
 * data. Members are spread across all of the gym's plans with a realistic
 * status mix (active / expiring / grace / expired / frozen), each with a
 * subscription, a payment, 3 placeholder face descriptors, and some
 * check-in history so charts have data.
 *
 * Usage (from the server/ directory):
 *   npx tsx scripts/add-fake-members.ts            # default: gym 1 (demo)
 *   npx tsx scripts/add-fake-members.ts --gym 2    # target another gym
 *
 * NOTE: face descriptors are random 128-d vectors — they will never match a
 * real face. Enroll real faces through the UI.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY_MS);
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function randomDescriptor(): number[] {
  return Array.from({ length: 128 }, () => Number((Math.random() * 0.4 - 0.2).toFixed(6)));
}

// expiresIn: days until expiry (negative = already expired).
// Statuses assume default settings: expiring <= 7 days, grace 0..-3, expired < -3.
const FAKE_MEMBERS = [
  { name: 'Bereket Girma',      sex: 'male',   expiresIn: 27,  status: 'active' },
  { name: 'Bethlehem Tadesse',  sex: 'female', expiresIn: 22,  status: 'active' },
  { name: 'Henok Alemayehu',    sex: 'male',   expiresIn: 19,  status: 'active' },
  { name: 'Ruth Abraham',       sex: 'female', expiresIn: 25,  status: 'active' },
  { name: 'Natnael Worku',      sex: 'male',   expiresIn: 14,  status: 'active' },
  { name: 'Mahlet Yohannes',    sex: 'female', expiresIn: 11,  status: 'active' },
  { name: 'Eyob Mengistu',      sex: 'male',   expiresIn: 29,  status: 'active' },
  { name: 'Eden Teshome',       sex: 'female', expiresIn: 16,  status: 'active' },
  { name: 'Biniam Tsegaye',     sex: 'male',   expiresIn: 9,   status: 'active' },
  { name: 'Tsion Demissie',     sex: 'female', expiresIn: 21,  status: 'active' },
  { name: 'Robel Gebremedhin',  sex: 'male',   expiresIn: 13,  status: 'active' },
  { name: 'Rahel Wondimu',      sex: 'female', expiresIn: 24,  status: 'active' },
  { name: 'Amanuel Getachew',   sex: 'male',   expiresIn: 6,   status: 'expiring' },
  { name: 'Hiwot Kassahun',     sex: 'female', expiresIn: 3,   status: 'expiring' },
  { name: 'Dagim Negash',       sex: 'male',   expiresIn: 5,   status: 'expiring' },
  { name: 'Kalkidan Abebe',     sex: 'female', expiresIn: -1,  status: 'grace' },
  { name: 'Mikias Solomon',     sex: 'male',   expiresIn: -3,  status: 'grace' },
  { name: 'Feven Berhanu',      sex: 'female', expiresIn: -8,  status: 'expired' },
  { name: 'Fikru Zeleke',       sex: 'male',   expiresIn: -15, status: 'expired' },
  { name: 'Marta Zewdu',        sex: 'female', expiresIn: 18,  status: 'frozen' },
] as const;

async function main(): Promise<void> {
  const gymArgIdx = process.argv.indexOf('--gym');
  const gymId = gymArgIdx === -1 ? 1 : Number(process.argv[gymArgIdx + 1]);
  if (!Number.isInteger(gymId) || gymId < 1) {
    throw new Error('--gym must be a positive integer');
  }

  const gym = await db('gyms').where({ id: gymId }).first();
  if (!gym) throw new Error(`Gym ${gymId} not found`);

  const plans: Array<{ id: number; name: string; duration_days: number; price: string }> =
    await db('plans').where({ gym_id: gymId }).orderBy('id');
  if (plans.length === 0) throw new Error(`Gym ${gymId} has no plans — create one first`);

  const marker = await db('users')
    .where({ gym_id: gymId })
    .orderBy(db.raw(`role = 'owner'`), 'desc')
    .first();
  if (!marker) throw new Error(`Gym ${gymId} has no users to mark payments`);

  // Unique phone base per run so re-running never collides.
  const phoneBase = 910000000 + (Date.now() % 1000000) * 100;

  await db.transaction(async (trx) => {
    for (const [i, spec] of FAKE_MEMBERS.entries()) {
      const plan = plans[i % plans.length]!;
      const frozen = spec.status === 'frozen';
      const expiresAt = daysFromNow(spec.expiresIn);
      const startsAt = new Date(expiresAt.getTime() - plan.duration_days * DAY_MS);

      const [member] = await trx('members')
        .insert({
          gym_id: gymId,
          full_name: spec.name,
          phone: `+251${phoneBase + i}`,
          sex: spec.sex,
          status: spec.status,
          joined_at: startsAt,
        })
        .returning('id');

      await trx('face_descriptors').insert(
        Array.from({ length: 3 }, () => ({
          member_id: member.id,
          descriptor: randomDescriptor(),
        })),
      );

      const [subscription] = await trx('subscriptions')
        .insert({
          gym_id: gymId,
          member_id: member.id,
          plan_id: plan.id,
          starts_at: dateOnly(startsAt),
          expires_at: dateOnly(expiresAt),
          status: frozen ? 'frozen' : spec.status === 'expired' ? 'expired' : 'active',
          frozen_at: frozen ? daysFromNow(-2) : null,
          frozen_days_remaining: frozen ? spec.expiresIn : null,
        })
        .returning('id');

      await trx('payments').insert({
        gym_id: gymId,
        member_id: member.id,
        subscription_id: subscription.id,
        amount: plan.price,
        method: i % 3 === 0 ? 'telebirr' : 'cash',
        marked_by: marker.id,
        note: 'Fake member seed',
        created_at: startsAt,
      });

      // Light check-in history for members whose plan already started.
      if (spec.status === 'active' || spec.status === 'expiring') {
        const checkIns: Record<string, unknown>[] = [];
        const peakHours = [6, 7, 8, 17, 18, 19];
        for (let day = 10; day >= 1; day--) {
          if (Math.random() >= 0.5) continue;
          const start = daysFromNow(-day);
          start.setHours(peakHours[Math.floor(Math.random() * peakHours.length)]!, Math.floor(Math.random() * 60), 0, 0);
          checkIns.push({
            gym_id: gymId,
            member_id: member.id,
            checked_in_at: start,
            checked_out_at: new Date(start.getTime() + (60 + Math.random() * 60) * 60 * 1000),
            checkout_method: 'auto',
            decision: 'allowed',
            confidence: Number((0.3 + Math.random() * 0.15).toFixed(3)),
          });
        }
        if (checkIns.length > 0) await trx('check_ins').insert(checkIns);
      }

      // eslint-disable-next-line no-console
      console.log(`+ ${spec.name.padEnd(20)} ${plan.name.padEnd(16)} ${spec.status}`);
    }
  });

  // eslint-disable-next-line no-console
  console.log(`\nAdded ${FAKE_MEMBERS.length} fake members to gym ${gymId} (${gym.name}).`);
  await db.destroy();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
