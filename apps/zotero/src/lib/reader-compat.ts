import { around } from "monkey-around";

type ReaderManagerCompat = _ZoteroTypes.Reader & {
  _readers?: _ZoteroTypes.ReaderInstance[];
  readers?: _ZoteroTypes.ReaderInstance[];
};

type ReaderInstanceCompat = _ZoteroTypes.ReaderInstance & {
  _iframe?: { contentWindow?: typeof globalThis | null } | null;
  _iframeWindow?: typeof globalThis | null;
  _popupset?: Element | null;
  _window?: typeof globalThis | null;
  popupset?: Element | null;
};

export function readerInstances(
  reader: _ZoteroTypes.Reader = Zotero.Reader,
): _ZoteroTypes.ReaderInstance[] {
  const manager = reader as ReaderManagerCompat;
  const instances = manager._readers ?? manager.readers;
  return Array.isArray(instances) ? instances : [];
}

export function readerPrototype(
  reader: _ZoteroTypes.Reader = Zotero.Reader,
): (Record<string, unknown> & _ZoteroTypes.ReaderInstance) | null {
  return (
    (readerInstances(reader)[0]?.constructor?.prototype as
      | (Record<string, unknown> & _ZoteroTypes.ReaderInstance)
      | undefined) ?? null
  );
}

export function readerIframeWindow(
  reader: _ZoteroTypes.ReaderInstance,
): typeof globalThis | null {
  const compat = reader as ReaderInstanceCompat;
  return (
    compat._iframeWindow ??
    compat._iframe?.contentWindow ??
    compat._window ??
    null
  );
}

export function readerPopupset(
  reader: _ZoteroTypes.ReaderInstance,
): Element | null {
  const compat = reader as ReaderInstanceCompat;
  return compat._popupset ?? compat.popupset ?? null;
}

export function onReaderPrototypeAvailable(
  callback: () => boolean,
): Disposable {
  if (callback()) return { [Symbol.dispose]() {} };
  let unload: (() => void) | null = null;
  unload = around(Zotero.Reader as Record<string, unknown>, {
    open: (next) =>
      function (this: _ZoteroTypes.Reader, ...args: unknown[]) {
        const result = (next as (...inner: unknown[]) => unknown).apply(
          this,
          args,
        );
        if (callback()) {
          unload?.();
          unload = null;
        }
        return result;
      },
  });
  return {
    [Symbol.dispose]() {
      unload?.();
      unload = null;
    },
  };
}
