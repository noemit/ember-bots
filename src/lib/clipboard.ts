/**
 * Copies text, falling back to `execCommand('copy')` when the async Clipboard API is unavailable
 * or refused.
 *
 * `navigator.clipboard` is **undefined** in an insecure context — which is what Ember's remote
 * access is (plain HTTP on a Tailscale address). Every copy in the app has to go through this
 * helper rather than calling `navigator.clipboard` directly, or it silently fails on a remote
 * browser.
 *
 * The fallback focuses the temporary textarea before selecting, then restores focus: browsers
 * refuse `execCommand('copy')` when the selection is inside an unfocused node, or when a Radix
 * dialog's focus trap is holding focus elsewhere.
 */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard API refused (no focus, permissions, or a transient browser check); try below.
  }
  if (typeof document === 'undefined' || !document.body) return false;
  const active = document.activeElement as { focus?: (options?: FocusOptions) => void } | null;
  const previous = typeof active?.focus === 'function' ? active : null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
    previous?.focus?.({ preventScroll: true });
  }
};
