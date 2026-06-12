import { redirect } from 'next/navigation';

// The Support page is retired — ticket creation and tracking now live in the
// Ticketing tool. Redirect keeps old bookmarks/links working.
export default function SupportPage() {
  redirect('/ticketing');
}
