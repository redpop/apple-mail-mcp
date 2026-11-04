// Platzhalter: Task 7 ersetzt diese Datei durch setup und doctor.
export async function runCli(mode: 'setup' | 'doctor', _args: string[]): Promise<number> {
  process.stderr.write(`apple-mail-actions-mcp ${mode}: not implemented yet\n`)
  return 1
}
