import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../config/database';
import { hashApiKey } from '../../config/slackCrypto';

// Machine authentication for the AD automation: `Authorization: Bearer adk_…`.
// The raw key is SHA-256-hashed and matched against a SlackBot.apiKeyHash. On
// success the bot is attached to the request. No cookies / user session involved.
export interface AdBot { id: string; name: string }

export async function adKeyAuth(req: Request & { bot?: AdBot }, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers['authorization'] ?? '';
  const m = /^Bearer\s+(adk_[a-f0-9]{8,})$/i.exec(String(header));
  if (!m) { res.status(401).json({ error: 'Missing or malformed API key', code: 'AD_KEY_MISSING' }); return; }
  const bot = await prisma.slackBot.findFirst({
    where: { apiKeyHash: hashApiKey(m[1]!) },
    select: { id: true, name: true, enabled: true },
  });
  if (!bot) { res.status(401).json({ error: 'Invalid API key', code: 'AD_KEY_INVALID' }); return; }
  if (!bot.enabled) { res.status(403).json({ error: 'Bot is disabled', code: 'AD_BOT_DISABLED' }); return; }
  req.bot = { id: bot.id, name: bot.name };
  next();
}
