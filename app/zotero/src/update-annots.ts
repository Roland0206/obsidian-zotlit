interface UpdateAnnot {
  id: string;
  text?: string;
  color?: string;
  comment?: string;
  position?: { pageIndex: number };
}

/**
 * @see https://github.com/zotero/zotero/blob/14bb46f43421816493b10bc30d1745c5cde86484/test/tests/pdfReaderTest.js#L122-L141
 */
export async function updateAnnotations(
  reader: _ZoteroTypes.ReaderInstance,
  annots: UpdateAnnot[],
) {
  const iframeWindow = getReaderIframeWindow(reader);
  if (!iframeWindow) throw new Error("Reader iframe window not found");

  const clonedAnnots = Components.utils.cloneInto(annots, iframeWindow);
  const readerWindow = (iframeWindow as any).wrappedJSObject ?? iframeWindow;

  const annotationManager = readerWindow._reader?._annotationManager;
  if (typeof annotationManager?.updateAnnotations === "function") {
    await annotationManager.updateAnnotations(clonedAnnots);
    return;
  }

  const annotationsStore =
    readerWindow.viewerInstance?._viewer?._annotationsStore;
  if (typeof annotationsStore?.updateAnnotations === "function") {
    await annotationsStore.updateAnnotations(clonedAnnots);
    return;
  }

  throw new Error("Reader annotation updater not found");
}

function getReaderIframeWindow(
  reader: _ZoteroTypes.ReaderInstance,
): typeof globalThis | null {
  const readerWithWindow = reader as _ZoteroTypes.ReaderInstance & {
    _iframeWindow?: typeof globalThis | null;
    _iframe?: { contentWindow?: typeof globalThis | null } | null;
    _window?: typeof globalThis | null;
  };
  return (
    readerWithWindow._iframeWindow ??
    readerWithWindow._iframe?.contentWindow ??
    readerWithWindow._window ??
    null
  );
}
