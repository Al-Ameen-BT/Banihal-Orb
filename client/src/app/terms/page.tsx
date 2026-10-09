import LegalDoc from '@/components/LegalDoc';

export const metadata = {
  title: 'Terms and Conditions · Banihal Technologies',
  description: 'Terms and Conditions for the Banihal Technologies platform.',
};

export default function TermsPage() {
  return <LegalDoc file="terms.md" updated="01/06/2026" />;
}
