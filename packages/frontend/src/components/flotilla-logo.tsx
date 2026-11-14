import { cn } from '../lib/utils';

/** Official Flotilla lockup. `mark` is the sonar/wing icon without wordmark. */
export function FlotillaLogo({
  mark = false,
  alt = 'Flotilla',
  className,
}: {
  mark?: boolean;
  alt?: string;
  className?: string;
}) {
  return (
    <img
      src={mark ? '/brand/flotilla-mark.png' : '/brand/flotilla-logo.png'}
      alt={alt}
      draggable={false}
      decoding="async"
      className={cn('block select-none', className)}
    />
  );
}
