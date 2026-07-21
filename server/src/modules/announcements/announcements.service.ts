import { query } from '../../config/db';

export interface AnnouncementRow {
  id: string;
  title: string;
  message: string;
  level: string;
  createdAt: Date;
}

// Announcements are global-with-scope: customerId IS NULL means "all orgs", so the
// visibility boundary is this explicit filter (customerId null OR the caller's org),
// plus active and not-yet-expired.
export async function listForCustomer(customerId: string): Promise<AnnouncementRow[]> {
  return query<AnnouncementRow>(
    `SELECT "id","title","message","level","createdAt"
       FROM "Announcement"
      WHERE "active" = true
        AND ("customerId" IS NULL OR "customerId" = $1)
        AND ("expiresAt" IS NULL OR "expiresAt" > $2)
      ORDER BY "createdAt" DESC`,
    [customerId, new Date()],
  );
}
