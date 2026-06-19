import fs from 'fs/promises';
import path from 'path';
import ReactMarkdown from 'react-markdown';

export const metadata = {
  title: 'Privacy Policy',
  description: 'Privacy Policy for our platform',
};

export default async function PrivacyPolicyPage() {
  const filePath = path.join(process.cwd(), 'content', 'privacy.md');
  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    content = '# Privacy Policy\n\n*(Document not found)*';
  }

  return (
    <div className="min-h-screen bg-slate-50 py-16 px-6">
      <div className="max-w-3xl mx-auto bg-white p-8 sm:p-12 rounded-2xl shadow-sm border border-slate-200">
        <div className="prose prose-slate max-w-none text-slate-600">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
