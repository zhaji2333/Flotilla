import { cn } from '../lib/utils';

// Decorative destroyer-style sonar sweep: expanding active pings, a rotating
// searchlight wedge and a few fading contacts. Pure CSS so it stays cheap.
export function SonarField({ className }: { className?: string }) {
  return (
    <div className={cn('sonar-field', className)} aria-hidden="true">
      <span className="sonar-crosshair" />
      <span className="sonar-range sonar-range-1" />
      <span className="sonar-range sonar-range-2" />
      <span className="sonar-scan" />
      <span className="sonar-ring" />
      <span className="sonar-ring sonar-ring-delay-1" />
      <span className="sonar-ring sonar-ring-delay-2" />
      <span className="sonar-sweep" />
      <span className="sonar-core" />
      <span className="sonar-blip sonar-blip-1" />
      <span className="sonar-blip sonar-blip-2" />
      <span className="sonar-blip sonar-blip-3" />
    </div>
  );
}
