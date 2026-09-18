import { prisma } from '../config/database';
import { env } from '../config/env';
import { sendServiceExpiryEmail } from '../modules/mail/mail.service';

// ─── Service expiry reminders (daily) ─────────────────────────────────────────
// Sent at a cadence of days before a service's end date. Each configured window
// fires exactly ONCE per service: a reminder is sent only when the whole
// remaining-days count equals one of the windows, and once sent the service is
// bookmarked with lastRemindedAt (today) so the same window cannot re-fire. As
// the count ticks down day by day each window hits exactly one day.
//
// A service that just expired without ever being reminded (e.g. a manually
// back-dated end date) gets a single final notice, then is bookmarked too.

const DAY = 86_400_000;

export const DEFAULT_REMINDER_WINDOWS = [30, 14, 7, 3, 1];

export function reminderWindows(): number[] {
  const raw = env.SERVICE_EXPIRY_REMINDER_DAYS;
  if (!raw) return DEFAULT_REMINDER_WINDOWS;
  const parsed = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0);
  return parsed.length ? parsed : DEFAULT_REMINDER_WINDOWS;
}

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

/** Send every due expiry reminder. Returns the number of services reminded. */
export async function runExpiryReminders(now = new Date()): Promise<number> {
  const today = startOfToday();
  const windows = new Set(reminderWindows());
  const services = await prisma.customerService.findMany({
    where: { endDate: { gte: today } },
    include: { customer: { select: { name: true, mailId: true } } },
  });

  // Expired-but-never-reminded services get one final notice on their first pass.
  const expired = await prisma.customerService.findMany({
    where: { endDate: { lt: today }, lastRemindedAt: null },
    include: { customer: { select: { name: true, mailId: true } } },
  });

  let reminded = 0;
  for (const s of [...services, ...expired]) {
    const daysLeft = Math.ceil((s.endDate.getTime() - now.getTime()) / DAY);
    const due = s.endDate.getTime() < today.getTime() || windows.has(daysLeft);
    if (!due) continue;
    if (s.lastRemindedAt && s.lastRemindedAt >= today) continue;

    const admins = await prisma.user.findMany({ where: { customerId: s.customerId, role: 'ORG_ADMIN' }, select: { email: true } });
    const recipients = new Set(admins.map((a) => a.email));
    if (s.customer.mailId) recipients.add(s.customer.mailId);

    for (const email of recipients) {
      try {
        await sendServiceExpiryEmail(email, { orgName: s.customer.name, serviceName: s.name, endDate: s.endDate, daysLeft });
      } catch {
        // mail failure is non-fatal — skip the bookmark so the next pass retries.
        continue;
      }
    }

    await prisma.customerService.update({ where: { id: s.id }, data: { lastRemindedAt: new Date() } });
    reminded += 1;
  }
  return reminded;
}

/** Start the daily loop. Re-entrant fast: the day-gate skips until tomorrow. */
export function startExpiryReminders(): void {
  let lastRanDay = '';
  const tick = async () => {
    const today = new Date();
    const day = today.toISOString().slice(0, 10);
    if (day === lastRanDay) return;
    lastRanDay = day;
    try {
      const n = await runExpiryReminders();
      if (n > 0) console.log(`📧 Expiry reminders: ${n} service(s) mailed today`);
    } catch (err) {
      console.error('⚠️  Expiry reminder pass failed:', err);
    }
  };
  void tick();
  const handle = setInterval(tick, 30 * 60_000);
  handle.unref();
}