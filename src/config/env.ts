import dotenv from 'dotenv';

dotenv.config();

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: Number(optional('PORT', '4000')),
  clientUrl: optional('CLIENT_URL', 'http://localhost:5173'),
  /** CLIENT_URL may be a comma-separated list (Vercel prod + preview + localhost). */
  corsOrigins: optional('CLIENT_URL', 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
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
  // Feedback email (Gmail SMTP). SMTP_USER/SMTP_PASS must be a Gmail address
  // + App Password (2-Step Verification required) for sending to work.
  mail: {
    user: optional('SMTP_USER', ''),
    pass: optional('SMTP_PASS', ''),
    feedbackTo: optional('FEEDBACK_TO', 'miki123mbt@gmail.com'),
  },
} as const;
