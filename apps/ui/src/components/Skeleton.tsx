/** `Skeleton` (06 UI-34, UI-50): the shape of the final content; static under reduced motion. */
export function Skeleton({
  width = '100%',
  height = '1rem',
  radius = 'var(--radius-sm)',
}: {
  width?: string;
  height?: string;
  radius?: string;
}) {
  return (
    <span className="skeleton" style={{ width, height, borderRadius: radius }} aria-hidden="true" />
  );
}
