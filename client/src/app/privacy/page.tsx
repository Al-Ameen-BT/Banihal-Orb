import LegalDoc from '@/components/LegalDoc';

export const metadata = {
  title: 'Privacy Policy · Banihal Technologies',
  description: 'Privacy Policy for the Banihal Technologies platform.',
};

export default function PrivacyPage() {
  return <LegalDoc file="privacy.md" />;
}
