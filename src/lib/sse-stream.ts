import type { Listener, PollerEvent } from "@/lib/poller/registry";
import { dropFrame, encodeEventFrame, HEARTBEAT_FRAME, HEARTBEAT_MS } from "@/lib/sse";

/**
 * What a subscriber may buffer before it counts as behind (#489). A frame is
 * queued at once and read as fast as the socket takes it; a healthy viewer
 * empties this between cycles, a stalled one does not.
 */
export const SUBSCRIBER_BUFFER_BYTES = 1024 * 1024;

/** The stream's own handle, for what the route attaches (the guard, the drain). */
export interface StreamHandle {
  /** Enqueue a frame; a closed stream ignores it. */
  write(frame: string | Uint8Array): void;
  /** Unsubscribe, stop every timer, and close the stream. Idempotent. */
  close(): void;
}

/**
 * One viewer's dashboard stream: a poller subscription written as SSE frames,
 * with a heartbeat and backpressure (#489).
 *
 * - Every event goes through {@link encodeEventFrame}, which serializes an
 *   event object once however many streams send it.
 * - After each cycle (`tick`), a stream holding more than
 *   {@link SUBSCRIBER_BUFFER_BYTES} unread is behind; behind for `slowTicks`
 *   cycles in a row, it is sent a `drop` frame and closed, and `onDrop` is
 *   told. The other subscribers of the poller carry on.
 *
 * `attach` is where the route hangs what else can end the stream (the
 * session guard, the drain hook); it returns their cleanup.
 */
export function subscriberStream(input: {
  subscribe: (listener: Listener, resumeToken: string | null) => () => void;
  resumeToken: string | null;
  slowTicks: number;
  signal?: AbortSignal;
  onDrop?: (reason: "slow") => void;
  attach?: (handle: StreamHandle) => () => void;
  bufferBytes?: number;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // Set in `start`; a reader that cancels (the client went away) ends it too.
  let end = () => {};
  return new ReadableStream<Uint8Array>(
    {
      cancel() {
        end();
      },
      start(controller) {
        let closed = false;
        let behind = 0;
        let unsubscribe = () => {};
        let detach = () => {};
        const write = (frame: string | Uint8Array) => {
          if (closed) return;
          try {
            controller.enqueue(typeof frame === "string" ? encoder.encode(frame) : frame);
          } catch {
            /* controller closed */
          }
        };
        const handle: StreamHandle = {
          write,
          close() {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            unsubscribe();
            detach();
            input.signal?.removeEventListener("abort", handle.close);
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          },
        };
        end = handle.close;
        const send = (event: PollerEvent, eventId?: string) => {
          write(encodeEventFrame(event, eventId));
          if (event.type !== "tick") return;
          // `desiredSize` is the buffer's room left; below zero, the reader
          // is more than a buffer behind.
          behind = (controller.desiredSize ?? 0) < 0 ? behind + 1 : 0;
          if (behind >= input.slowTicks) {
            write(dropFrame());
            input.onDrop?.("slow");
            handle.close();
          }
        };
        // Prime the stream so the connection opens promptly.
        write(": connected\n\n");
        // A comment every so often, so a proxy that closes quiet connections
        // does not close one whose dashboard refreshes slowly (#43).
        const heartbeat = setInterval(() => write(HEARTBEAT_FRAME), HEARTBEAT_MS);
        unsubscribe = input.subscribe(send, input.resumeToken);
        detach = input.attach?.(handle) ?? (() => {});
        if (input.signal?.aborted) handle.close();
        else input.signal?.addEventListener("abort", handle.close);
      },
    },
    new ByteLengthQueuingStrategy({
      highWaterMark: input.bufferBytes ?? SUBSCRIBER_BUFFER_BYTES,
    }),
  );
}
