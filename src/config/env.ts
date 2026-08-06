import dotenv from 'dotenv';

dotenv.config();

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

/**
 * The Android app is not served from a web origin: Capacitor serves the bundle
 * from the WebView's own scheme, so requests arrive with one of these Origins
 * rather than CLIENT_URL. They are constant across every install of the app,
 * so they are always allowed — there is no deployment where the app is valid
 * but these are not.
 *
 * `capacitor://localhost` is the iOS scheme, `https://localhost` the Android
 * one (set via server.androidScheme). Both are listed so a future iOS build
 * needs no server change.
 */
const NATIVE_ORIGINS = ['capacitor://localhost', 'https://localhost', 'http://localhost'];

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: Number(optional('PORT', '4000')),
  clientUrl: optional('CLIENT_URL', 'http://localhost:5173'),
  /** CLIENT_URL may be a comma-separated list (Vercel prod + preview + localhost). */
  // Array.from (not a spread literal) so `as const` below leaves this a
  // mutable string[] — cors() and Socket.io both reject a readonly array.
  corsOrigins: Array.from(
    new Set([
      ...optional('CLIENT_URL', 'http://localhost:5173')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
      ...NATIVE_ORIGINS,
    ]),
  ),
  autoMigrate: optional('AUTO_MIGRATE', 'true') === 'true',
  databaseUrl: process.env.DATABASE_URL,
  db: {
    host: optional('DB_HOST', 'localhost'),
    port: Number(optional('DB_PORT', '5432')),
    user: optional('DB_USER', 'postgres'),
    password: optional('DB_PASSWORD', 'postgres'),
    database: optional('DB_NAME', 'gym_management'),
  },
  jwt: {
    accessSecret: optional('JWT_ACCESS_SECRET', 'dev-access-secret'),
    refreshSecret: optional('JWT_REFRESH_SECRET', 'dev-refresh-secret'),
    accessTtl: optional('JWT_ACCESS_TTL', '15m'),
    refreshTtlDays: 30,
  },
  // Platform super-admin (the product owner). The /platform admin area is
  // disabled until PLATFORM_ADMIN_PASSWORD is set.
  platformAdmin: {
    email: optional('PLATFORM_ADMIN_EMAIL', 'miki123mbt@gmail.com'),
    password: optional('PLATFORM_ADMIN_PASSWORD', ''),
  },
  // Feedback email (Gmail SMTP). SMTP_USER/SMTP_PASS must be a Gmail address
  // + App Password (2-Step Verification required) for sending to work.
  mail: {
    user: optional('SMTP_USER', ''),
    pass: optional('SMTP_PASS', ''),
    feedbackTo: optional('FEEDBACK_TO', 'miki123mbt@gmail.com'),
  },
} as const;
