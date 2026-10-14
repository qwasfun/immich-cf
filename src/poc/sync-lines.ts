export interface SyncLine {
  type: string;
  data: unknown;
  ack: string;
}

// HTTP intermediaries may split or combine these chunks; only newlines frame events.
export function syncLines(events: SyncLine[]): Response {
  const encoder = new TextEncoder();
  let source = events;
  let index = 0;
  let pending: Uint8Array | undefined;
  let offset = 0;
  const release = () => {
    source = [];
    pending = undefined;
  };
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          try {
            if (!pending) {
              if (index === source.length) {
                release();
                controller.close();
                return;
              }
              pending = encoder.encode(JSON.stringify(source[index++]) + '\n');
              offset = 0;
            }
            const end = Math.min(offset + 16 * 1024, pending.length);
            controller.enqueue(pending.subarray(offset, end));
            offset = end;
            if (offset === pending.length) pending = undefined;
          } catch (error) {
            release();
            controller.error(error);
          }
        },
        cancel: release,
      },
      { highWaterMark: 0 },
    ),
    { headers: { 'Content-Type': 'application/jsonlines+json' } },
  );
}
