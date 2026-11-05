import * as React from 'react';
import type { ViewerImage } from '../lib/gallery';

/**
 * How the transcript opens an image in the viewer. `App` provides one instance above the
 * columns and renders the single `<ImageViewer>` modal, so a transcript row (or a markdown
 * image) never owns viewer state itself.
 */
export type ImageViewerApi = {
  /** Open a gallery at `index` (a message's images, in order). */
  open: (images: ViewerImage[], index: number) => void;
  /** Open a single image (prose images, which have no message gallery). */
  openOne: (image: ViewerImage) => void;
};

export const ImageViewerContext = React.createContext<ImageViewerApi | null>(null);

/** Null outside a provider, so image surfaces stay inert rather than crashing. */
export const useImageViewer = (): ImageViewerApi | null => React.useContext(ImageViewerContext);
