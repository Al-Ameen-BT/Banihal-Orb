export default function BrandLogo({ height = 48, className = '' }: { height?: number; className?: string }) {
  return (
    <span
      className={`inline-block whitespace-nowrap font-semibold tracking-tight text-slate-900 ${className}`}
      style={{ fontSize: height * 0.65, lineHeight: `${height}px` }}
    >
      BanihalOrb
    </span>
  );
}
