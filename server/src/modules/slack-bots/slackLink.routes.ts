import { Router } from 'express';
import { requireRole } from '../../middleware/rbac.middleware';
import { issueLinkCode } from './slackLink';

// Authed endpoint issuing a one-time Slack-link code (shown once to the user;
// redeemed from a Slack DM: "link LINK-XXXX"). Any signed-in user may link their
// own Slack identity.
const router = Router();

router.post('/', requireRole('USER', 'ORG_ADMIN', 'ADMINISTRATOR'), async (req, res, next) => {
  try {
    const { code, expiresInSeconds } = await issueLinkCode(req.user.userId, req.user.customerId);
    res.json({ code, expiresInSeconds, hint: `DM any connected platform bot: link ${code}` });
  } catch (err) {
    next(err);
  }
});

export default router;