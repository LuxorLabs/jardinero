// OutputTail keeps the end of a run's output, which is all a run that died leaves to read:
// the stream is gone and the CLI wrote no result.
export class OutputTail {
  private readonly lines: string[] = [];
  private bytes = 0;

  constructor(
    private readonly maxLines = 200,
    private readonly maxBytes = 64 * 1024,
  ) {}

  push(line: string): void {
    this.lines.push(line);
    this.bytes += line.length + 1;
    // Dropping from the front is what makes this the tail rather than a transcript.
    while (
      this.lines.length > this.maxLines ||
      (this.bytes > this.maxBytes && this.lines.length > 1)
    ) {
      this.bytes -= (this.lines.shift()?.length ?? 0) + 1;
    }
  }

  isEmpty(): boolean {
    return this.lines.length === 0;
  }

  text(): string {
    return `${this.lines.join('\n')}\n`;
  }
}
