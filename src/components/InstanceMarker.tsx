/** Icon-only equivalent of the configured instance-colour text underline.
 * Kept separate from the highlight-coloured active-column underline. */
export default function InstanceMarker({ color, className }: { color: number | undefined; className: string }) {
  if (color === undefined) return null;
  return <span data-instance-marker={color} aria-hidden="true"
    className={`pointer-events-none absolute left-1/2 h-[2px] w-6 -translate-x-1/2 rounded-full ${className}`}
    style={{ backgroundColor: `var(--instance-marker-${color})` }} />;
}
