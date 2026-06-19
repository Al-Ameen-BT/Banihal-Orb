import fs from 'fs/promises';
import path from 'path';
import ReactMarkdown from 'react-markdown';

export const metadata = {
  title: 'Terms and Conditions',
  description: 'Terms and Conditions for our platform',
};

export default async function TermsPage() {
  const filePath = path.join(process.cwd(), 'content', 'terms.md');
  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    content = '# Terms and Conditions\n\n*(Document not found)*';
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
