// Framing model of frozen v3.3.1 SyncApiRepository: streaming UTF-8, newline-only
// records, and an unterminated tail ignored at EOF. Not the Dart runtime/DTO layer.
export function decodeFrozenFraming(chunks) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let tail = '';
  const events = [];
  const append = (text) => {
    const lines = (tail + text).split('\n');
    tail = lines.pop();
    for (const line of lines) events.push(JSON.parse(line));
  };
  for (const chunk of chunks) append(decoder.decode(chunk, { stream: true }));
  append(decoder.decode());
  return { events, tail, complete: events.at(-1)?.type === 'SyncCompleteV1' };
}
