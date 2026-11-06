import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const unusedVars = ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }];

export default tseslint.config(
  // glyphs.ts is generated; glyph-arena/ is a one-off review playground, not app code.
  // Root-level *.mjs are throwaway capture scripts, not app code; .audit/ is the audit harness.
  // `build/notarize.js` is electron-builder's CommonJS hook: it is loaded by that tool, not bundled,
  // so `require` is the correct form there and the ESM/TS rules do not apply.
  { ignores: ['dist/', 'dist-electron/', 'node_modules/', 'release/', 'packages/', '.audit/', '*.mjs', 'build/notarize.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/set-state-in-render': 'error',
      'react-hooks/immutability': 'error',
      // The React Compiler lint rules (`refs`, `set-state-in-effect`, `purity`, ...) assume the
      // compiler is on. It isn't here, and this codebase deliberately uses "latest ref" updates
      // during render and state sync inside effects, so those rules are left off.
      '@typescript-eslint/no-unused-vars': unusedVars,
    },
  },
  {
    files: ['electron/**/*.ts', 'cli/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: { '@typescript-eslint/no-unused-vars': unusedVars },
  },
  {
    files: ['*.test.ts', 'vite.config.mts', 'eslint.config.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  }
);
