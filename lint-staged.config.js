// oxfmt が変更したファイルは lint-staged が自動で再ステージするため、
// 整形差分が後追いコミットに漏れない。
export default {
  "*.{ts,tsx}": ["oxfmt --write", "vitest related --passWithNoTests"],
  "*.{js,jsx,mjs,cjs,mts,cts,json,md}": ["oxfmt --write"],
  // 秘密情報は「コミット前」に止める。push まで待つと git 履歴に残り、
  // 修復に history rewrite が必要になる。staged のみなら約 0.27s。
  "*": ["secretlint"],
};
