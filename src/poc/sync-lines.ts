export interface SyncLine {
  type: string;
  data: unknown;
  ack: string;
}

// HTTP intermediaries may split or combine these chunks; only newlines frame events.
export function syncLines(events: SyncLine[] | AsyncIterable<SyncLine>): Response {
  const encoder = new TextEncoder();
  let source = Array.isArray(events) ? events : [];
  const iterator = Array.isArray(events) ? undefined : events[Symbol.asyncIterator]();
  let index = 0;
  let pending: Uint8Array | undefined;
  let offset = 0;
  let cancelled = false;
  const release = async () => {
    source = [];
    pending = undefined;
    await iterator?.return?.();
  };
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            if (cancelled) return;
            if (!pending) {
              const item = iterator
                ? await iterator.next()
                : index === source.length
                  ? { done: true as const }
                  : { done: false as const, value: source[index++]! };
              if (cancelled) return;
              if (item.done) {
                await release();
                if (!cancelled) controller.close();
                return;
              }
              pending = encoder.encode(JSON.stringify(item.value) + '\n');
              offset = 0;
            }
            const end = Math.min(offset + 16 * 1024, pending.length);
            controller.enqueue(pending.subarray(offset, end));
            offset = end;
            if (offset === pending.length) pending = undefined;
          } catch (error) {
            await release().catch(() => undefined);
            if (!cancelled) controller.error(error);
          }
        },
        async cancel() {
          cancelled = true;
          await release();
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { 'Content-Type': 'application/jsonlines+json' } },
  );
}
