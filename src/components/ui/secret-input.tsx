import * as React from 'react';
import { Input } from './input';

/**
 * A masked text field for secrets (API keys, tokens, passwords).
 *
 * It is deliberately **not** a password-typed input (`type=password`). On macOS, focusing one
 * turns on Secure Keyboard Entry, a single machine-wide OS flag that disables every third-party
 * keyboard event tap (skhd, Karabiner, Hammerspoon). Chromium clears the flag on blur, but a field
 * that is unmounted, hidden or minimised while still focused never sees that blur, so the flag
 * sticks and the whole machine silently loses its global shortcuts.
 *
 * `-webkit-text-security: disc` draws the same dots and never touches the flag. `secretInput.test.ts`
 * fails if a password-typed input reappears anywhere in the renderer.
 */
const SecretInput = React.forwardRef<HTMLInputElement, React.ComponentProps<typeof Input>>(
  function SecretInput({ style, ...props }, ref) {
    return (
      <Input
        {...props}
        ref={ref}
        type="text"
        autoComplete="off"
        spellCheck={false}
        style={{ WebkitTextSecurity: 'disc', ...style } as React.CSSProperties}
      />
    );
  }
);

export default SecretInput;
