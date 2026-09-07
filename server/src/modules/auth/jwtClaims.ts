/**
 * Registered claims asserted on every token this service issues and accepts.
 *
 * Both sides must agree: signAccessToken sets them, authMiddleware verifies them.
 * They cost nothing today (one service, one audience) and mean a token minted for
 * a different service can never be replayed against this one — which matters the
 * moment a second service shares JWT_ACCESS_SECRET, or an agent/webhook signer
 * starts issuing tokens of its own.
 *
 * Changing either value invalidates every outstanding access token (15-minute
 * blast radius — holders silently re-authenticate via the refresh cookie).
 */
export const JWT_ISSUER = 'b2b-saas-api';
export const JWT_AUDIENCE = 'b2b-saas-client';
