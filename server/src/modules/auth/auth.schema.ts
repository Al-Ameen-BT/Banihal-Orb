import { z } from 'zod';

// Shared password policy: 12+ chars with upper, lower, number, and symbol.
const PasswordSchema = z
  .string()
  .min(12)
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/,
    'Password must contain uppercase, lowercase, number, and special character',
  );

export const RegisterSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email(),
  password: PasswordSchema,
  organizationName: z.string().min(2).max(100),
  contactNumber: z.string().min(7, 'Contact number is required').max(20),
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Self-registration for a member joining an EXISTING organization. No org name:
// the organization is resolved server-side from the work-email domain.
export const RegisterUserSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email(),
  password: PasswordSchema,
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type RegisterUserInput = z.infer<typeof RegisterUserSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;

export const ForgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  newPassword: PasswordSchema,
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

// Email MFA: step 2 of login. `code` is the 6-digit value from the email.
export const VerifyMfaSchema = z.object({
  challengeId: z.string().min(1, 'Challenge is required'),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  rememberDevice: z.boolean().optional(), // "Remember this device for 7 days"
});

export const ResendMfaSchema = z.object({
  challengeId: z.string().min(1, 'Challenge is required'),
});

// Organization approval: the code a platform staff member hands to a new org's
// admin. Same shape as the MFA code, and validated the same way — the regex means
// a malformed body is rejected before it can consume one of the five attempts.
export const VerifyOrgApprovalSchema = z.object({
  challengeId: z.string().min(1, 'Challenge is required'),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit approval code'),
});

export const ResendOrgApprovalSchema = z.object({
  challengeId: z.string().min(1, 'Challenge is required'),
});

// Email verification: redeem the link, or ask for a fresh one.
export const VerifyEmailSchema = z.object({
  token: z.string().min(1, 'Token is required'),
});


export const ResendVerificationSchema = z.object({
  email: z.string().email('Invalid email address'),
});
export type ResendVerificationInput = z.infer<typeof ResendVerificationSchema>;
