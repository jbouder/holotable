/**
 * Said while the one automatic repair (#21) streams: the first answer did not
 * validate, and the preview that replaced it is the fix arriving.
 */
export function RepairingNote({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p role="status" className="fade-in text-xs text-muted">
      The first answer was not in the expected format. Fixing it automatically…
    </p>
  );
}
