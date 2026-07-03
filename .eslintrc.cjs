// Flat-config is the future, but the classic .eslintrc is still the most
// friction-free with the typescript-eslint + prettier combo. Keep it simple.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier', // turns off rules that conflict with Prettier — keep this last
  ],
  env: { node: true, es2022: true },
  ignorePatterns: ['dist/', 'node_modules/'],
  rules: {
    // Stubs intentionally have unused params (e.g. `input`) — allow `_`-prefixed.
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    // We use plenty of `any` at stub boundaries; warn, don't block.
    '@typescript-eslint/no-explicit-any': 'warn',
  },
};
