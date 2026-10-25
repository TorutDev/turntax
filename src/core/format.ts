/** Number formatting with no dependencies, for code that must not load the tokenizer (the VS Code extension's main thread). */
export function fmtTokens(n: number): string {
  return n.toLocaleString('en-US');
}
