import { Role } from '@prisma/client';
import type { PermissionKey } from '../config/permissions';

declare global {
  namespace Express {
    interface Request {
      user: {
        userId: string;
        customerId: string;
        role: Role;
        /** Vendor-staff role id. Null for customer accounts (USER / ORG_ADMIN). */
        platformRoleId: string | null;
        /**
         * Resolved once per request in auth.middleware. ALWAYS empty for customer
         * roles — `can()` refuses them before consulting this, so a stray entry
         * here could not grant anything either.
         */
        permissions: Set<PermissionKey>;
      };
    }
  }
}

export {};
