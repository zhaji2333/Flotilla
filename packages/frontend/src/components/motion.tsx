import { motion, type Variants } from 'motion/react';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

const ease = [0.16, 1, 0.3, 1] as const;

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 18, filter: 'blur(3px)' },
  show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.6, ease } },
};

export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: '-40px' }}
      variants={{
        hidden: { opacity: 0, y: 18, filter: 'blur(3px)' },
        show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.6, ease, delay } },
      }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="show"
      variants={{ hidden: {}, show: { transition: { staggerChildren: 0.055 } } }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div className={className} variants={fadeUp}>
      {children}
    </motion.div>
  );
}

export function PageTransition({ children, keyName }: { children: ReactNode; keyName: string }) {
  return (
    <motion.div
      key={keyName}
      className={cn('relative z-10')}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease }}
    >
      {children}
    </motion.div>
  );
}

export function AnimatedNumber({ value }: { value: number }) {
  return (
    <motion.span
      key={value}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease }}
      className="tabular-nums"
    >
      {value}
    </motion.span>
  );
}
