import LegalDoc from '@/components/LegalDoc';

export const metadata = {
  title: 'Privacy Policy · BanihalOrb',
  description: 'Privacy Policy for the BanihalOrb platform.',
};

export default function PrivacyPage() {
  return <LegalDoc file="privacy.md" />;
}
