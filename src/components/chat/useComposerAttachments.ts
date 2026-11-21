import * as React from 'react';
import type { FileAttachment } from '../../types';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  megabytes,
  readAttachment,
} from './helpers';

type UseComposerAttachmentsArgs = {
  composerKey: string | null;
  isAnswering: boolean;
  attachments: FileAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<FileAttachment[]>>;
  setAttachmentError: React.Dispatch<React.SetStateAction<string | null>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onActivate?: () => void;
};

export function useComposerAttachments({
  composerKey,
  isAnswering,
  attachments,
  setAttachments,
  setAttachmentError,
  textareaRef,
  onActivate,
}: UseComposerAttachmentsArgs) {
  const dragDepth = React.useRef(0);
  const [dragging, setDragging] = React.useState(false);

  React.useEffect(() => {
    if (!isAnswering) return;
    dragDepth.current = 0;
    setDragging(false);
  }, [isAnswering]);

  const addFiles = async (files: FileList | null) => {
    if (isAnswering || !files) return;
    let remaining =
      MAX_TOTAL_ATTACHMENT_BYTES -
      attachments.reduce((sum, file) => sum + Math.ceil(file.url.length * 0.75), 0);
    const accepted = [...files].filter((file) => {
      if (file.size > MAX_ATTACHMENT_BYTES || file.size > remaining) return false;
      remaining -= file.size;
      return true;
    });
    const skippedForSize = files.length - accepted.length;
    const oversized = [...files].filter((file) => file.size > MAX_ATTACHMENT_BYTES);
    const results = await Promise.allSettled(accepted.map(readAttachment));
    const read = results
      .filter((result): result is PromiseFulfilledResult<FileAttachment> => result.status === 'fulfilled')
      .map((result) => result.value);
    const unreadable = results.length - read.length;
    const problems = [
      skippedForSize > 0
        ? `${skippedForSize} exceeding the ${megabytes(MAX_ATTACHMENT_BYTES)} file / ${megabytes(MAX_TOTAL_ATTACHMENT_BYTES)} total limit`
        : null,
      oversized.length > 0
        ? `put ${oversized.length === 1 ? 'it' : 'them'} on the host's disk and send the path instead — a recording that big cannot ride in a message`
        : null,
      unreadable > 0 ? `${unreadable} could not be read` : null,
    ].filter((entry): entry is string => entry !== null);
    setAttachmentError(problems.length > 0 ? `Skipped ${problems.join(', ')}.` : null);
    if (read.length > 0) setAttachments((prev) => [...prev, ...read]);
  };

  const carriesFiles = (event: React.DragEvent) =>
    !isAnswering && Boolean(composerKey) && event.dataTransfer.types.includes('Files');

  const dropHandlers = {
    onDragEnter: (event: React.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: React.DragEvent) => {
      if (isAnswering) {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'none';
        }
        return;
      }
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!carriesFiles(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (event: React.DragEvent) => {
      if (isAnswering) {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        return;
      }
      if (!carriesFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      onActivate?.();
      void addFiles(event.dataTransfer.files);
      textareaRef.current?.focus();
    },
  };

  return {
    dragging,
    addFiles,
    dropHandlers,
  };
}
