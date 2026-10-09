// A labelled count. Extracted from app/users/page.tsx when the client lists moved
// to /clients and both pages needed it — same markup, no behaviour change.
export default function SummaryTile({ label, value, tone, hint }: {
  label: string; value: number | string; tone: 'emerald' | 'brand' | 'violet' | 'amber'; hint?: string;
}) {
  const dot = { emerald: 'bg-emerald-500', brand: 'bg-brand', violet: 'bg-violet-500', amber: 'bg-amber-500' }[tone];
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">{label}</p>
        <span className={`w-2 h-2 rounded-full ${dot}`} />
      </div>
      <p className="font-mono text-2xl font-bold text-slate-900 tabular-nums leading-none">{value}</p>
      {/* Says WHICH population the number counts — four tiles of bare digits
          side by side are otherwise indistinguishable from one another. */}
      {hint && <p className="mt-1.5 text-[11px] text-slate-400 leading-tight">{hint}</p>}
    </div>
  );
}
