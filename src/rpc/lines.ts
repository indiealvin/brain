/**
 * JSONL line splitting over a byte stream (protocol §2: one JSON object per
 * line, UTF-8, `\n` terminated). Multi-byte characters split across chunks
 * are decoded correctly; a trailing `\r` is dropped; a final line without a
 * newline is still delivered at end of stream.
 */
export async function forEachLine(stream: AsyncIterable<Uint8Array | string>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  const flush = () => {
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  };
  for await (const chunk of stream) {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    flush();
  }
  buf += decoder.decode();
  flush();
  if (buf !== "") onLine(buf.endsWith("\r") ? buf.slice(0, -1) : buf);
}
