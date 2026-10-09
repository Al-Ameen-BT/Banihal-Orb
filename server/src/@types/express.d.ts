import { Role } from '@prisma/client';
import type { PermissionKey } from '../config/permissions';
import type { ExternalScope, ExternalStore } from '../modules/external-api/external-keys';

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
      /** Present after externalAuth on /api/external machine routes. */
      external?: {
        clientId: string;
        keyId: string;
        scopes: ExternalScope[];
        store: ExternalStore;
        /** Allowed orgs (main-DB customerIds); empty for admin-store keys. */
        orgs: string[];
      };
    }
  }
}

export {};
