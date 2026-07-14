# Broker image attachments

## Problem

The composer converts pasted or dropped images to `data:` URLs and shows them in
its local tray. The broker chat path drops those URLs during enqueue, and the
executor then creates an empty `ChatGenerateStreamRequest.images`. The model
therefore receives text only. The atomic user-message insert also omits
`attachments_json`, so the image disappears from the transcript as soon as the
optimistic client state is replaced by the persisted message.

## Chosen approach

Carry a small, explicit image payload through the existing broker input instead
of bypassing the queue or treating pasted images as host-path attachments.

1. Add optional `images` to the enqueue API, broker input, and stored task JSON.
2. Pass those image URLs from the desktop bridge through `enqueueTurn`.
3. At execution, validate/read the saved image array and pass it to the
   canonical model request.
4. Store presentation metadata for both conventional file attachments and
   inline images in the atomic user message, including the inline preview URL so
   the message remains renderable after reload.

This keeps the queue as the sole chat path, avoids writing clipboard images to
an arbitrary filesystem location, and makes model input and transcript state
derive from the same durable turn data.

## Boundaries and safeguards

- Accept only `data:image/...` values; malformed/non-image values are ignored.
- Limit the number of inline images and their total serialized size before
  persisting the task, returning a clear enqueue error if the limits are
  exceeded.
- Preserve the existing file-attachment path and its local-first access grant.
- Do not retrofit the already-completed failed turn: it has no stored image
  payload and cannot be reconstructed.

## Tests

- Frontend request test: `enqueueTurn` serializes inline images.
- Broker test: a queued turn retains its image payload in `input_json`.
- Gateway test: the executor forwards stored images into the model request.
- Chat-store test: an atomic linked user message retains image attachment
  metadata and its preview after a snapshot reload.
- Manual installed-app check: paste one image, send a vision prompt, confirm the
  image is visible in the user bubble and that the assistant describes it.

## Success criteria

A pasted or dragged image reaches a vision-capable model in a broker turn and
remains visible in that user message after streaming completes, reload, and app
restart. Plain text and ordinary file attachments remain unchanged.
