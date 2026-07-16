import type { Knex } from 'knex';
import bcrypt from 'bcryptjs';

/**
 * Demo seed: one gym, owner + staff account, 3 plans, 10 members covering
 * every lifecycle status, payments for each subscription, and ~2 weeks of
 * check-in history (so the dashboard peak-hours chart has data).
 *
 * Login after seeding:
 *   owner: owner@demogym.et / password123
 *   staff: staff@demogym.et / password123
 *
 * NOTE: seeded face descriptors are random 128-d vectors. They will never
 * match a real face (distance >> 0.5) — enroll real faces through the UI.
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

function at(date: Date, hour: number, minute: number): Date {
  const d = new Date(date);
  d.setHours(hour, minute, 0, 0);
  return d;
}

export async function seed(knex: Knex): Promise<void> {
  // Row-level triggers (payments immutability) do not fire on TRUNCATE.
  await knex.raw(`
    TRUNCATE TABLE
      audit_logs, events, notifications, check_ins, guests, payments,
      subscriptions, face_descriptors, members, plans, refresh_tokens,
      users, gyms
    RESTART IDENTITY CASCADE
  `);

  // --- gym -----------------------------------------------------------
  const [gym] = await knex('gyms')
    .insert({
      name: 'Addis Power Gym',
      address: 'Bole Road, Addis Ababa',
      phone: '+251911000000',
      settings: JSON.stringify({
        grace_period_days: 3,
        auto_checkout_hours: 3,
        expiry_reminder_days: 7,
        absence_nudge_days: 5,
        match_threshold: 0.5,
        closing_time: '22:00',
      }),
    })
    .returning('id');
  const gymId = gym.id;

  // --- staff ---------------------------------------------------------
  const passwordHash = await bcrypt.hash('password123', 10);
  const [owner] = await knex('users')
    .insert({
      gym_id: gymId,
      name: 'Mikiyas Owner',
      phone: '+251911000001',
      email: 'owner@demogym.et',
      password_hash: passwordHash,
      role: 'owner',
    })
    .returning('id');
  await knex('users').insert({
    gym_id: gymId,
    name: 'Front Desk Staff',
    phone: '+251911000002',
    email: 'staff@demogym.et',
    password_hash: passwordHash,
    role: 'staff',
  });

  // --- plans ---------------------------------------------------------
  const plans = await knex('plans')
    .insert([
      {
        gym_id: gymId,
        name: 'Regular Monthly',
        duration_days: 30,
        price: 1500,
        sessions_per_day: 1,
        includes: JSON.stringify({}),
        allowed_hours: null,
      },
      {
        gym_id: gymId,
        name: 'Premium Monthly',
        duration_days: 30,
        price: 2500,
        sessions_per_day: null, // unlimited
        includes: JSON.stringify({ aerobics: true, sauna: true }),
        allowed_hours: null,
      },
      {
        gym_id: gymId,
        name: 'Morning Only',
        duration_days: 30,
        price: 1000,
        sessions_per_day: 1,
        includes: JSON.stringify({}),
        allowed_hours: '06:00-12:00',
      },
    ])
    .returning(['id', 'name', 'duration_days', 'price']);

  const regular = plans[0]!;
  const premium = plans[1]!;
  const morning = plans[2]!;

  // --- members -------------------------------------------------------
  // expiresIn: days until expiry (negative = already expired)
  // Statuses assume settings above: expiring <= 7 days, grace 0..-3, expired < -3.
  const memberSpecs = [
    { name: 'Abebe Kebede',  sex: 'male',   plan: premium, expiresIn: 20,  status: 'active' },
    { name: 'Sara Tesfaye',  sex: 'female', plan: regular, expiresIn: 15,  status: 'active' },
    { name: 'Dawit Haile',   sex: 'male',   plan: premium, expiresIn: 25,  status: 'active' },
    { name: 'Hanna Girma',   sex: 'female', plan: morning, expiresIn: 12,  status: 'active' },
    { name: 'Yonas Tadesse', sex: 'male',   plan: regular, expiresIn: 18,  status: 'active' },
    { name: 'Meron Alemu',   sex: 'female', plan: regular, expiresIn: 9,   status: 'active' },
    { name: 'Samuel Bekele', sex: 'male',   plan: premium, expiresIn: 4,   status: 'expiring' },
    { name: 'Liya Mekonnen', sex: 'female', plan: regular, expiresIn: -2,  status: 'grace' },
    { name: 'Kaleb Assefa',  sex: 'male',   plan: regular, expiresIn: -10, status: 'expired' },
    { name: 'Selam Fikru',   sex: 'female', plan: premium, expiresIn: 12,  status: 'frozen' },
  ] as const;

  const memberIds: number[] = [];

  for (const [i, spec] of memberSpecs.entries()) {
    const frozen = spec.status === 'frozen';
    const expiresAt = daysFromNow(spec.expiresIn);
    const startsAt = new Date(expiresAt.getTime() - spec.plan.duration_days * DAY_MS);

    const [member] = await knex('members')
      .insert({
        gym_id: gymId,
        full_name: spec.name,
        phone: `+2519${String(11000100 + i)}`,
        sex: spec.sex,
        status: spec.status,
        joined_at: startsAt,
      })
      .returning('id');
    memberIds.push(member.id);

    // 3 random captures per member (placeholders — see file header note)
    await knex('face_descriptors').insert(
      Array.from({ length: 3 }, () => ({
        member_id: member.id,
        descriptor: randomDescriptor(),
      })),
    );

    const [subscription] = await knex('subscriptions')
      .insert({
        gym_id: gymId,
        member_id: member.id,
        plan_id: spec.plan.id,
        starts_at: dateOnly(startsAt),
        expires_at: dateOnly(expiresAt),
        status: frozen ? 'frozen' : spec.status === 'expired' ? 'expired' : 'active',
        frozen_at: frozen ? daysFromNow(-1) : null,
        frozen_days_remaining: frozen ? spec.expiresIn : null,
      })
      .returning('id');

    await knex('payments').insert({
      gym_id: gymId,
      member_id: member.id,
      subscription_id: subscription.id,
      amount: spec.plan.price,
      method: i % 2 === 0 ? 'cash' : 'telebirr',
      marked_by: owner.id,
      note: 'Seed payment',
      created_at: startsAt,
    });
  }

  // --- check-in history (last 14 days, peak hours 6-8am and 5-8pm) ----
  const activeIdx = [0, 1, 2, 3, 4, 5, 6]; // members likely to visit
  const checkIns: Record<string, unknown>[] = [];
  const peakHours = [6, 7, 7, 8, 17, 17, 18, 18, 19, 20];

  for (let day = 14; day >= 1; day--) {
    const date = daysFromNow(-day);
    const visitors = activeIdx.filter(() => Math.random() < 0.6);
    for (const idx of visitors) {
      const start = at(date, peakHours[Math.floor(Math.random() * peakHours.length)]!, Math.floor(Math.random() * 60));
      checkIns.push({
        gym_id: gymId,
        member_id: memberIds[idx],
        checked_in_at: start,
        checked_out_at: new Date(start.getTime() + (60 + Math.random() * 60) * 60 * 1000),
        checkout_method: 'auto',
        decision: 'allowed',
        confidence: Number((0.3 + Math.random() * 0.15).toFixed(3)),
      });
    }
  }

  // Today: three visitors, two still inside (open sessions -> occupancy = 2)
  const now = new Date();
  const today: Array<{ idx: number; hoursAgo: number; out: boolean }> = [
    { idx: 0, hoursAgo: 3, out: true },
    { idx: 1, hoursAgo: 1.5, out: false },
    { idx: 4, hoursAgo: 0.5, out: false },
  ];
  for (const t of today) {
    const start = new Date(now.getTime() - t.hoursAgo * 60 * 60 * 1000);
    checkIns.push({
      gym_id: gymId,
      member_id: memberIds[t.idx],
      checked_in_at: start,
      checked_out_at: t.out ? new Date(start.getTime() + 90 * 60 * 1000) : null,
      checkout_method: t.out ? 'manual' : null,
      decision: 'allowed',
      confidence: 0.35,
    });
  }

  await knex('check_ins').insert(checkIns);

  // --- events for today's activity ------------------------------------
  await knex('events').insert(
    today.map((t) => {
      const spec = memberSpecs[t.idx]!;
      return {
        gym_id: gymId,
        type: 'check_in',
        severity: 'green',
        message: `${spec.name} checked in · ${spec.expiresIn} days remaining`,
        member_id: memberIds[t.idx],
        created_at: new Date(now.getTime() - t.hoursAgo * 60 * 60 * 1000),
      };
    }),
  );

  // eslint-disable-next-line no-console
  console.log('Seeded demo gym: owner@demogym.et / staff@demogym.et (password123)');
}
