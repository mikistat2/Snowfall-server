export type MemberStatus = 'active' | 'expiring' | 'grace' | 'expired' | 'frozen';
export type SubscriptionStatus = 'active' | 'frozen' | 'expired';
export type Severity = 'green' | 'yellow' | 'orange' | 'red' | 'blue';
export type DecisionCode =
  | 'allowed'
  | 'denied_expired'
  | 'denied_frozen'
  | 'denied_session_limit'
  | 'denied_hours'
  | 'override';
export type PaymentMethod = 'cash' | 'telebirr' | 'bank' | 'other';

export interface GymSettings {
  grace_period_days: number;
  auto_checkout_hours: number;
  expiry_reminder_days: number;
  absence_nudge_days: number;
  match_threshold: number;
  closing_time: string;
  /** 'auto': allowed members pass instantly; 'manual': staff approve each entry. */
  entry_mode: 'auto' | 'manual';
}

export const DEFAULT_SETTINGS: GymSettings = {
  grace_period_days: 3,
  auto_checkout_hours: 3,
  expiry_reminder_days: 7,
  absence_nudge_days: 5,
  match_threshold: 0.5,
  closing_time: '22:00',
  entry_mode: 'auto',
};

export interface GymRow {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  telegram_bot_token: string | null;
  settings: GymSettings;
  status: 'active' | 'frozen';
  frozen_at: string | null;
  admin_note: string | null;
}

export interface UserRow {
  id: number;
  gym_id: number;
  name: string;
  phone: string | null;
  email: string;
  password_hash: string;
  role: 'owner' | 'staff';
  telegram_chat_id: number | null;
  telegram_link_token: string | null;
}

export interface PlanRow {
  id: number;
  gym_id: number;
  name: string;
  duration_days: number;
  price: string; // NUMERIC comes back as string
  sessions_per_day: number | null;
  includes: Record<string, boolean>;
  allowed_hours: string | null;
  active: boolean;
}

export interface MemberRow {
  id: number;
  gym_id: number;
  full_name: string;
  phone: string | null;
  sex: 'male' | 'female' | null;
  telegram_chat_id: number | null;
  telegram_username: string | null;
  telegram_link_token: string | null;
  photo_url: string | null;
  status: MemberStatus;
  joined_at: Date;
}

export interface SubscriptionRow {
  id: number;
  gym_id: number;
  member_id: number;
  plan_id: number;
  starts_at: Date;
  expires_at: Date;
  frozen_at: Date | null;
  frozen_days_remaining: number | null;
  status: SubscriptionStatus;
}

export interface CheckInRow {
  id: number;
  gym_id: number;
  member_id: number | null;
  guest_id: number | null;
  checked_in_at: Date;
  checked_out_at: Date | null;
  checkout_method: 'camera' | 'auto' | 'manual' | null;
  decision: DecisionCode;
  confidence: number | null;
}
