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
  /** false: gym has no camera — enroll without face captures, monitor shows gym name only. */
  camera_enabled: boolean;
}

export const DEFAULT_SETTINGS: GymSettings = {
  grace_period_days: 3,
  auto_checkout_hours: 3,
  expiry_reminder_days: 7,
  absence_nudge_days: 5,
  match_threshold: 0.5,
  closing_time: '22:00',
  entry_mode: 'auto',
  camera_enabled: true,
};

export interface GymRow {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  telegram_bot_token: string | null;
  settings: GymSettings;
  status: 'pending' | 'active' | 'frozen';
  frozen_at: string | null;
  admin_note: string | null;
  approved_at: string | null;
  subscription_ends_at: string | null;
  is_trial: boolean;
  payment_reason_code: string | null;
  billing_plan_id: number | null;
  billing_cycle: BillingCycle | null;
  comped: boolean;
  /**
   * Platform-level entitlements, set only by the platform owner. The gym's own
   * `settings.camera_enabled` is a preference *within* what these permit —
   * gymModel.getSettings ANDs the two, so server logic never has to check both.
   */
  camera_allowed: boolean;
  telegram_allowed: boolean;
}

/** The features the platform owner can grant or revoke per gym. */
export interface GymFeatures {
  camera_allowed: boolean;
  telegram_allowed: boolean;
}

/** The two entitlements, named the way the notice table and the client refer to them. */
export type FeatureKey = 'camera' | 'telegram';

/**
 * One platform decision about one feature, captured at the moment it was
 * taken. See the 20260826000009 migration.
 */
export interface FeatureNoticeRow {
  id: number;
  gym_id: number;
  feature: FeatureKey;
  /** The state the feature moved TO. */
  allowed: boolean;
  note: string | null;
  changed_by: string | null;
  acknowledged_at: string | null;
  acknowledged_by: number | null;
  created_at: string;
}

/** Single-row global platform configuration (see platform_settings table). */
export interface PlatformSettings {
  trial_mode: boolean;
  trial_days: number;
}

// ---------------------------------------------------------------- billing --
// Gyms paying the platform by verified bank/wallet transfer.

export type BillingCycle = 'MONTHLY' | 'YEARLY';
export type BillingProvider = 'CBE' | 'TELEBIRR' | 'CASH';
export type BillingSource = 'MANUAL' | 'IMAGE' | 'ADMIN';
export type BillingStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';

/**
 * `warn` is recorded on the row and shown to the admin but does not reject;
 * `skip` means there was nothing to compare against. Only `fail` rejects.
 */
export type CheckState = 'pass' | 'fail' | 'warn' | 'skip';

export interface PaymentCheck {
  key: string;
  label: string;
  state: CheckState;
  expected: string | null;
  actual: string | null;
  message: string;
}

export interface BillingPlanRow {
  id: number;
  name: string;
  description: string | null;
  monthly_price: string; // NUMERIC comes back as string
  yearly_price: string;
  currency: string;
  is_active: boolean;
  sort_order: number;
}

export interface BillingSettings {
  payments_required: boolean;
  cbe_enabled: boolean;
  cbe_account_number: string | null;
  cbe_account_name: string | null;
  telebirr_enabled: boolean;
  telebirr_phone: string | null;
  telebirr_account_name: string | null;
  currency: string;
  receipt_max_age_days: number;
  grace_days: number;
  instructions: string | null;
}

export interface BillingPaymentRow {
  id: number;
  gym_id: number;
  billing_plan_id: number | null;
  provider: BillingProvider;
  source: BillingSource;
  status: BillingStatus;
  reference: string | null;
  reason_code: string | null;
  verified_reference: string | null;
  selected_cycle: BillingCycle | null;
  granted_cycle: BillingCycle | null;
  amount: string | null;
  currency: string | null;
  expected_amount: string | null;
  payer_name: string | null;
  payer_account: string | null;
  receiver_name: string | null;
  receiver_account: string | null;
  transaction_at: Date | null;
  period_start: Date | null;
  period_end: Date | null;
  failure_reason: string | null;
  warnings: string[] | null;
  checks: PaymentCheck[] | null;
  raw_response?: unknown;
  recorded_by: string | null;
  note: string | null;
  verified_at: Date | null;
  created_at: Date;
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
  /** Set = removed from the gym's active roster, but kept for their payment history. */
  archived_at: Date | null;
}

export interface SubscriptionRow {
  id: number;
  gym_id: number;
  member_id: number;
  plan_id: number;
  /** Postgres DATE — read back as a plain "YYYY-MM-DD" string (see db/knex.ts). */
  starts_at: string;
  expires_at: string;
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
