/**
 * All Telegram message templates, English first with Amharic below —
 * members see both. Keep plain text (no parse_mode pitfalls with names).
 */

export function linkedWelcome(memberName: string, gymName: string): string {
  return (
    `✅ ${memberName}, your Telegram is now linked to ${gymName}. ` +
    `You'll get membership reminders here.\n` +
    `✅ ${memberName}፣ የቴሌግራም አካውንትዎ ከ${gymName} ጋር ተገናኝቷል። የአባልነት ማሳወቂያዎችን እዚህ ያገኛሉ።`
  );
}

export function adminLinkedWelcome(userName: string, gymName: string): string {
  return `✅ ${userName}, this chat will now receive admin alerts and daily summaries for ${gymName}.`;
}

export function expiryReminder(memberName: string, daysLeft: number, gymName: string): string {
  if (daysLeft > 0) {
    return (
      `⏳ ${memberName}, your ${gymName} membership expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. ` +
      `Renew at the front desk to keep training!\n` +
      `⏳ ${memberName}፣ የ${gymName} አባልነትዎ በ${daysLeft} ቀን ውስጥ ያበቃል። እባክዎ በጊዜ ያድሱ!`
    );
  }
  return (
    `⚠️ ${memberName}, your ${gymName} membership expires today. Renew at the front desk to avoid interruption.\n` +
    `⚠️ ${memberName}፣ የ${gymName} አባልነትዎ ዛሬ ያበቃል። እባክዎ ያድሱ።`
  );
}

export function enteredGrace(memberName: string, graceDaysLeft: number, gymName: string): string {
  return (
    `🔔 ${memberName}, your ${gymName} membership has expired. You have a ${graceDaysLeft}-day grace period — ` +
    `please renew at the front desk.\n` +
    `🔔 ${memberName}፣ የ${gymName} አባልነትዎ አብቅቷል። የ${graceDaysLeft} ቀን የችሮታ ጊዜ አለዎት — እባክዎ ያድሱ።`
  );
}

export function receipt(memberName: string, amount: string, planName: string, expiresAt: string, gymName: string): string {
  return (
    `🧾 ${gymName} — payment received.\n` +
    `${memberName}: ${amount} ETB · ${planName}\nValid until ${expiresAt}. Thank you!\n` +
    `🧾 ክፍያዎ ተቀብለናል። እስከ ${expiresAt} ድረስ ያገለግላል። እናመሰግናለን!`
  );
}

/** 5+ motivational absence nudges, rotated per member. */
const NUDGES: ((name: string, days: number, gym: string) => string)[] = [
  (name, days, gym) =>
    `💪 ${name}, we haven't seen you at ${gym} for ${days} days. Your progress misses you — come back today!\n` +
    `💪 ${name}፣ ለ${days} ቀናት አላየንዎትም። ዛሬ ተመልሰው ይምጡ!`,
  (name, _days, gym) =>
    `🏋️ ${name}, the hardest part is walking through the door. ${gym} is ready when you are!\n` +
    `🏋️ ${name}፣ ከባዱ ነገር በሩን መግባት ብቻ ነው። እንጠብቅዎታለን!`,
  (name, days, _gym) =>
    `🔥 ${name}, ${days} rest days is enough recovery! Time to get back to it — see you at the gym.\n` +
    `🔥 ${name}፣ ${days} ቀን እረፍት በቂ ነው! ወደ ስፖርት እንመለስ።`,
  (name, _days, gym) =>
    `⭐ ${name}, consistency beats intensity. Even a light session at ${gym} keeps the habit alive!\n` +
    `⭐ ${name}፣ ቀጣይነት ከጥንካሬ ይበልጣል። ቀላል ልምምድም ቢሆን ይምጡ!`,
  (name, _days, _gym) =>
    `🎯 ${name}, your goals didn't take a break — don't let them wait. See you today?\n` +
    `🎯 ${name}፣ ግቦችዎ እረፍት አልወሰዱም — ዛሬ ይምጡ!`,
  (name, days, gym) =>
    `🙌 ${name}, ${days} days away and the weights are getting lonely at ${gym}. Come lift their spirits!\n` +
    `🙌 ${name}፣ መሣሪያዎቹ ናፍቀውዎታል! ይምጡና ያሰሯቸው።`,
];

export function absenceNudge(index: number, name: string, days: number, gym: string): string {
  const template = NUDGES[index % NUDGES.length]!;
  return template(name, days, gym);
}

export const NUDGE_COUNT = NUDGES.length;

export function trafficReply(count: number, label: 'quiet' | 'moderate' | 'busy'): string {
  const emoji = { quiet: '🟢', moderate: '🟡', busy: '🔴' }[label];
  const am = { quiet: 'ጸጥ ያለ', moderate: 'መካከለኛ', busy: 'የተጨናነቀ' }[label];
  return `${emoji} ${count} people inside right now — ${label}.\n${emoji} አሁን ${count} ሰዎች አሉ — ${am}።`;
}

export function trafficLabel(count: number): 'quiet' | 'moderate' | 'busy' {
  if (count <= 4) return 'quiet';
  if (count <= 12) return 'moderate';
  return 'busy';
}

export function unknownFaceAlert(count: number, gymName: string): string {
  return `🚨 ${gymName}: an unrecognized face has appeared ${count} times today at the entrance. Check the monitor.`;
}

export function dailySummary(input: {
  gymName: string;
  checkIns: number;
  revenue: number;
  expiringTomorrow: string[];
}): string {
  const expiring =
    input.expiringTomorrow.length === 0
      ? 'none'
      : `${input.expiringTomorrow.length} (${input.expiringTomorrow.slice(0, 5).join(', ')}${input.expiringTomorrow.length > 5 ? '…' : ''})`;
  return (
    `📊 ${input.gymName} — daily summary\n` +
    `• Check-ins today: ${input.checkIns}\n` +
    `• Revenue marked today: ${input.revenue.toLocaleString()} ETB\n` +
    `• Expiring tomorrow: ${expiring}`
  );
}
