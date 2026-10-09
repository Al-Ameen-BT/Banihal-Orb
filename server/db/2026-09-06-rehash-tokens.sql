-- ============================================================================
-- 2026-09-06-rehash-tokens.sql — one-time cutover for ADR-002 (bcrypt → SHA-256)
-- ----------------------------------------------------------------------------
-- RefreshToken and PasswordResetToken hashes moved from bcrypt (salted, so the
-- row could only be found by comparing against every row) to SHA-256 (indexed,
-- O(1)). Existing rows hold bcrypt digests that the new lookup can never match,
-- so they are dead weight that would only ever return "invalid token".
--
-- EFFECT: every user is signed out once and must log in again. Outstanding
-- password-reset links stop working; users request a new one. Both are expected.
--
-- Safe to re-run. Apply BEFORE or WITH the deploy that ships the code change —
-- running it late only means users see "invalid token" instead of a clean logout.
-- ============================================================================

DELETE FROM "RefreshToken";
DELETE FROM "PasswordResetToken";
