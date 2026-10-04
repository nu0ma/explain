import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'coverage/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    // { index, ...rest } のように、残りを取り出すために外すキーは使わなくてよい。
    rules: { 'no-unused-vars': ['error', { ignoreRestSiblings: true }] },
  },
  {
    // 再生ページに埋め込むスクリプトはブラウザで動く。
    files: ['src/runtime/**/*.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
  },
];
