import { trimBotHistory, HISTORY_RETENTION_DAYS } from '../modules/squid/squidBotStore';

// ─── Squid bot history retention (daily, D12) ─────────────────────────────────
// Commands and rule rows older than 90 days are trimmed; SquidBotState is
// latest-only (one row per bot, overwritten each poll) so it needs no pruning.
// Non-terminal commands are never trimmed by trimBotHistory — a queued or
// dispatched approval is live state, not history.

export function startSquidBotRetention(): void {
  let lastRanDay = '';
  const tick = async () => {
    const day = new Date().toISOString().slice(0, 10);
    if (day === lastRanDay) return;
    lastRanDay = day;
    try {
      const { commands, rules } = await trimBotHistory();
      if (commands || rules) {
        console.log(`🗄️  Squid bot retention: ${commands} command(s), ${rules} rule(s) older than ${HISTORY_RETENTION_DAYS}d trimmed`);
      }
    } catch (err) {
      console.error('⚠️  Squid bot retention pass failed:', err);
    }
  };
  void tick();
  const handle = setInterval(tick, 30 * 60_000);
  handle.unref();
}
