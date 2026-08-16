type SemaFrameMarkProps = Readonly<{
  className?: string;
}>;

/** Compact brand mark: an open frame containing a semantic spatial plane. */
export function SemaFrameMark({ className }: SemaFrameMarkProps) {
  return <svg
    className={className}
    viewBox="0 0 64 64"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    focusable="false"
  >
    <path className="semaframe-frame" d="M9 25V9h16M39 9h16v16M55 39v16H39M25 55H9V39" />
    <path className="semaframe-plane" d="m18 32 14-9 14 9-14 9-14-9Z" />
    <path className="semaframe-axis" d="M32 23v18" />
    <circle className="semaframe-node semaframe-node-primary" cx="18" cy="32" r="4" />
    <circle className="semaframe-node semaframe-node-secondary" cx="46" cy="32" r="4" />
    <circle className="semaframe-node semaframe-node-anchor" cx="32" cy="41" r="4" />
  </svg>;
}
