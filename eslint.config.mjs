import tseslint from 'typescript-eslint';

export default tseslint.config({
  files: ['src/**/*.ts', 'web/src/**/*.{ts,tsx}'],
  extends: [...tseslint.configs.recommended],
  rules: { '@typescript-eslint/consistent-type-imports': 'error' },
});
