import fs from 'fs/promises';
import path from 'path';
import Link from 'next/link';
import ReactMarkdown, { type Components } from 'react-markdown';

// Explicit element styling — the app does NOT ship @tailwindcss/typography, so
// the `prose` classes are inert and Tailwind's preflight strips default heading
// / list styles. Map each markdown element to Tailwind classes instead.
const components: Components = {
  h1: ({ children }) => <h1 className="text-3xl font-bold tracking-tight text-slate-900 mb-2">{children}</h1>,
  h2: ({ children }) => <h2 className="text-lg font-semibold text-slate-900 mt-9 mb-3 pb-1.5 border-b border-slate-100">{children}</h2>,
  h3: ({ children }) => <h3 className="text-base font-semibold text-slate-800 mt-6 mb-2">{children}</h3>,
  p:  ({ children }) => <p className="text-sm leading-relaxed text-slate-600 mb-4">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-6 space-y-1.5 mb-4 text-sm text-slate-600 marker:text-slate-400">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-6 space-y-1.5 mb-4 text-sm text-slate-600 marker:text-slate-400">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed pl-1">{children}</li>,
  a:  ({ children, href }) => <a href={href} className="text-brand hover:underline break-words">{children}</a>,
  strong: ({ children }) => <strong className="font-semibold text-slate-800">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  hr: () => <hr className="my-8 border-slate-200" />,
  blockquote: ({ children }) => <blockquote className="border-l-2 border-slate-200 pl-4 italic text-slate-500 mb-4">{children}</blockquote>,
};

/**
 * Server component that reads a committed markdown doc from `client/content/`
 * and renders it in a consistent legal-page shell. The raw `.md` is never
 * exposed as a static asset — it is read on the server and rendered to HTML.
 */
export default async function LegalDoc({ file, updated }: { file: string; updated?: string }) {
  const filePath = path.join(process.cwd(), 'content', file);
  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    content = '# Document unavailable\n\n*(This document could not be loaded.)*';
  }

  return (
    <div className="min-h-screen bg-slate-50 py-12 sm:py-16 px-6">
      <div className="max-w-3xl mx-auto">
        <div className="mb-6 flex items-center justify-between">
          <Link href="/login" className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M15.75 19.5 8.25 12l7.5-7.5" />
            </svg>
            Back to sign in
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <Link href="/terms" className="font-medium text-slate-500 hover:text-brand transition-colors">Terms</Link>
            <Link href="/privacy" className="font-medium text-slate-500 hover:text-brand transition-colors">Privacy</Link>
          </div>
        </div>

        <article className="bg-white p-8 sm:p-12 rounded-2xl shadow-sm border border-slate-200">
          <ReactMarkdown components={components}>{content}</ReactMarkdown>
          {updated && <p className="mt-10 pt-6 border-t border-slate-100 text-xs text-slate-400">Last updated: {updated}</p>}
        </article>
      </div>
    </div>
  );
}
