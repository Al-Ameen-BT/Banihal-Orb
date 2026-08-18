import Image from 'next/image';

// The Banihal wordmark, in the one place its dimensions are written down.
// `next/image` needs a real width/height to reserve space, and the six call sites
// previously each hard-coded a bare <img> — so the intrinsic size lived nowhere and
// the aspect ratio was whatever CSS happened to allow.
//
// public/banihal-logo.png is 1638×326. We pass the RENDERED size (derived from the
// requested height) rather than the intrinsic size, so the props match what CSS
// actually paints and Next has no width/height mismatch to warn about.
const RATIO = 1638 / 326;

export default function BrandLogo({ height = 48, className = '' }: { height?: number; className?: string }) {
  return (
    <Image
      src="/banihal-logo.png"
      alt="Banihal Technologies"
      width={Math.round(height * RATIO)}
      height={height}
      priority
      className={`w-auto object-contain ${className}`}
    />
  );
}
