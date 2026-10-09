'use client';

import { useEffect, useRef } from 'react';
import { animate, useMotionValue, useTransform, motion } from 'framer-motion';

interface AnimatedNumberProps {
  value: number;
  duration?: number;
  format?: (n: number) => string;
  className?: string;
}

export default function AnimatedNumber({
  value,
  duration = 1.2,
  format = (n) => Math.round(n).toLocaleString(),
  className,
}: AnimatedNumberProps) {
  const motionValue = useMotionValue(0);
  const display = useTransform(motionValue, (latest) => format(latest));
  const hasMounted = useRef(false);

  useEffect(() => {
    const from = hasMounted.current ? motionValue.get() : 0;
    hasMounted.current = true;

    const controls = animate(motionValue, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      from,
    });
    return controls.stop;
  }, [value, duration, motionValue]);

  return <motion.span className={className}>{display}</motion.span>;
}
