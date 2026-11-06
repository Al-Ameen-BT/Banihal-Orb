import LegalDoc from '@/components/LegalDoc';

export const metadata = {
  title: 'Terms and Conditions · BanihalOrb',
  description: 'Terms and Conditions for the BanihalOrb platform.',
};

export default function TermsPage() {
  return <LegalDoc file="terms.md" updated="01/06/2026" />;
}
