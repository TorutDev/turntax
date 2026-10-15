/** `turntax mcp`: turntax as a Model Context Protocol server over stdio. */
export async function runMcp(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  void argv;
  void env;
  process.stderr.write('turntax: mcp is not implemented yet\n');
  return 2;
}
