import { around } from "monkey-around";

import { requireMessage } from "@/lib/l10n";
import { logger as appLogger } from "@/lib/logger";
import {
  onReaderPrototypeAvailable,
  readerPopupset,
  readerPrototype,
} from "@/lib/reader-compat";

import { copyObjectKeys } from "./copy-key.js";
import {
  exploreInObsidian,
  importInObsidian,
  importManyInObsidian,
  openInObsidian,
  readerTopLevelItem,
  updateManyInObsidian,
} from "./obsidian.js";

const logger = appLogger.getChild(["menus", "legacy"]);

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const LEGACY_MARK = "data-zotlit-legacy-menu";

type LegacyEvent = MouseEvent | KeyboardEvent;
type ReaderPopupData = {
  currentID?: string;
};

function createXul(doc: Document, tag: string): Element {
  const factory = (
    doc as Document & { createXULElement?: (tag: string) => Element }
  ).createXULElement;
  return factory ? factory.call(doc, tag) : doc.createElementNS(XUL_NS, tag);
}

function setVisible(el: Element, visible: boolean): void {
  el.setAttribute("hidden", visible ? "false" : "true");
}

function removeLegacyChildren(parent: Element): void {
  for (const node of parent.querySelectorAll(`[${LEGACY_MARK}]`)) node.remove();
}

function addSeparator(parent: Element): Element {
  const el = createXul(parent.ownerDocument, "menuseparator");
  el.setAttribute(LEGACY_MARK, "true");
  parent.appendChild(el);
  return el;
}

interface LegacyMenuItemOptions {
  label: string;
  onCommand: (event: LegacyEvent) => void;
  onShowing?: (item: Element) => void;
}

function addMenuItem(
  parent: Element,
  { label, onCommand, onShowing }: LegacyMenuItemOptions,
): Element {
  const item = createXul(parent.ownerDocument, "menuitem");
  item.setAttribute(LEGACY_MARK, "true");
  item.setAttribute("label", label);
  item.addEventListener("command", (event) => onCommand(event as LegacyEvent));
  parent.appendChild(item);
  if (onShowing) {
    onShowing(item);
    parent.addEventListener("popupshowing", () => onShowing(item));
  }
  return item;
}

function addSubmenu(
  parent: Element,
  label: string,
  build: (popup: Element) => void,
): Element {
  const menu = createXul(parent.ownerDocument, "menu");
  menu.setAttribute(LEGACY_MARK, "true");
  menu.setAttribute("label", label);
  const popup = createXul(parent.ownerDocument, "menupopup");
  menu.appendChild(popup);
  parent.appendChild(menu);
  build(popup);
  return menu;
}

function selectedItems(): Zotero.Item[] {
  const pane = Zotero.getActiveZoteroPane?.();
  const selected = pane?.getSelectedItems?.() ?? [];
  return Array.isArray(selected) ? selected : [];
}

function allRegularTargets(): Zotero.Item[] {
  const seen = new Set<number>();
  const items: Zotero.Item[] = [];
  for (const item of selectedItems()) {
    const target = item.isAttachment() ? item.parentItem : item;
    if (!target?.isRegularItem() || seen.has(target.id)) continue;
    seen.add(target.id);
    items.push(target);
  }
  return items;
}

function noteItems(): Zotero.Item[] {
  return selectedItems().filter((item) => item.isNote());
}

function regularItemsWithChildNotes(): Zotero.Item[] {
  return allRegularTargets().filter((item) => item.getNotes().length > 0);
}

function runRegular(action: "open" | "update", scope?: "metadata"): void {
  const items = allRegularTargets();
  if (items.length === 0) return;
  if (action === "update" && items.length > 1) {
    void updateManyInObsidian(items, scope);
    return;
  }
  for (const item of items) openInObsidian(action, item, scope);
}

function registerPopup(
  selector: string,
  build: (popup: Element) => void,
): Disposable {
  const win = Zotero.getMainWindow();
  const popup = win?.document.querySelector(selector);
  if (!popup) {
    logger.warn("legacy menu popup not found", { selector });
    return { [Symbol.dispose]() {} };
  }
  build(popup);
  return {
    [Symbol.dispose]() {
      removeLegacyChildren(popup);
    },
  };
}

export async function registerLegacyItemMenu(): Promise<Disposable> {
  const submenuLabel = await requireMessage("zotlit-menu-submenu");
  const openLabel = await requireMessage("zotlit-menu-item-open");
  const copyLabel = await requireMessage("zotlit-menu-item-copy-key");
  const updateLabel = await requireMessage("zotlit-menu-item-update");
  const updateMetaLabel = await requireMessage(
    "zotlit-menu-item-update-metadata",
  );
  const childNotesLabel = await requireMessage(
    "zotlit-menu-item-import-child-notes",
  );
  const notesLabel = await requireMessage("zotlit-menu-item-import-notes");
  const exploreLabel = await requireMessage("zotlit-menu-item-explore");

  return registerPopup("#zotero-itemmenu", (popup) => {
    addSeparator(popup);
    addMenuItem(popup, {
      label: openLabel,
      onCommand: () => runRegular("open"),
      onShowing: (item) => setVisible(item, allRegularTargets().length === 1),
    });
    addMenuItem(popup, {
      label: copyLabel,
      onCommand: () => copyObjectKeys(selectedItems()),
      onShowing: (item) => setVisible(item, selectedItems().length >= 1),
    });
    addSubmenu(popup, submenuLabel, (submenu) => {
      addMenuItem(submenu, {
        label: updateLabel,
        onCommand: () => runRegular("update"),
        onShowing: (item) => setVisible(item, allRegularTargets().length >= 1),
      });
      addMenuItem(submenu, {
        label: updateMetaLabel,
        onCommand: () => runRegular("update", "metadata"),
        onShowing: (item) => setVisible(item, allRegularTargets().length >= 1),
      });
      addMenuItem(submenu, {
        label: childNotesLabel,
        onCommand: () => {
          const items = regularItemsWithChildNotes();
          if (items.length === 1) {
            importInObsidian(items[0]!.id, "child");
          } else if (items.length > 1) {
            void importManyInObsidian(
              items.map((item) => item.id),
              "child",
            );
          }
        },
        onShowing: (item) =>
          setVisible(item, regularItemsWithChildNotes().length >= 1),
      });
      addMenuItem(submenu, {
        label: notesLabel,
        onCommand: () => {
          const items = noteItems();
          if (items.length === 1) {
            importInObsidian(items[0]!.id, "note");
          } else if (items.length > 1) {
            void importManyInObsidian(
              items.map((item) => item.id),
              "note",
            );
          }
        },
        onShowing: (item) => setVisible(item, noteItems().length >= 1),
      });
      addMenuItem(submenu, {
        label: exploreLabel,
        onCommand: () => {
          const items = allRegularTargets();
          if (items.length === 1) exploreInObsidian(items[0]!);
        },
        onShowing: (item) => setVisible(item, allRegularTargets().length === 1),
      });
    });
  });
}

function appendReaderItems(
  popup: Element,
  entries: Array<{ label: string; command: () => void }>,
): void {
  removeLegacyChildren(popup);
  addSeparator(popup);
  for (const entry of entries) {
    addMenuItem(popup, { label: entry.label, onCommand: entry.command });
  }
}

export async function registerLegacyReaderMenus(): Promise<Disposable> {
  const pageLabel = await requireMessage("zotlit-menu-reader-page-open");
  const exploreLabel = await requireMessage("zotlit-menu-reader-annot-explore");
  const copyLabel = await requireMessage("zotlit-menu-reader-annot-copy-key");
  let unload: (() => void) | null = null;

  const hook = (): boolean => {
    const proto = readerPrototype();
    if (!proto) return false;
    const patches: Record<
      string,
      (next: (...args: unknown[]) => unknown) => unknown
    > = {};
    const resolve = (legacy: string, modern: string): string | null => {
      if (typeof proto[legacy] === "function") return legacy;
      if (typeof proto[modern] === "function") return modern;
      return null;
    };
    const annotPopup = resolve("_openAnnotationPopup", "openAnnotationPopup");
    const pagePopup = resolve("_openPagePopup", "openPagePopup");

    if (annotPopup) {
      patches[annotPopup] = (next) =>
        function (
          this: _ZoteroTypes.ReaderInstance,
          data: ReaderPopupData,
          ...args: unknown[]
        ) {
          const result = next.call(this, data, ...args);
          const popupset = readerPopupset(this);
          if (!popupset) return result;
          const item = readerTopLevelItem(this);
          if (item === null) return result;
          for (const popup of popupset.children) {
            if (popup.nodeName !== "menupopup") continue;
            appendReaderItems(popup, [
              {
                label: exploreLabel,
                command: () => exploreInObsidian(item, data.currentID),
              },
              {
                label: copyLabel,
                command: () => {
                  if (!data.currentID) return;
                  copyObjectKeys([
                    { key: data.currentID, libraryID: item.libraryID },
                  ]);
                },
              },
            ]);
          }
          return result;
        };
    }

    if (pagePopup) {
      patches[pagePopup] = (next) =>
        function (this: _ZoteroTypes.ReaderInstance, ...args: unknown[]) {
          const result = next.apply(this, args);
          const popupset = readerPopupset(this);
          if (!popupset) return result;
          const item = readerTopLevelItem(this);
          if (item === null) return result;
          for (const popup of popupset.children) {
            if (popup.nodeName !== "menupopup") continue;
            appendReaderItems(popup, [
              { label: pageLabel, command: () => openInObsidian("open", item) },
            ]);
          }
          return result;
        };
    }

    if (Object.keys(patches).length === 0) return false;
    unload = around(
      proto as Record<string, unknown>,
      patches as Record<string, (next: unknown) => unknown>,
    );
    return true;
  };

  const availability = onReaderPrototypeAvailable(hook);
  return {
    [Symbol.dispose]() {
      availability[Symbol.dispose]();
      unload?.();
      unload = null;
    },
  };
}

export async function registerLegacyMenus(): Promise<AsyncDisposable> {
  logger.info("registering legacy Zotero 8 menus");
  await using stack = new AsyncDisposableStack();
  stack.use(await registerLegacyItemMenu());
  stack.use(await registerLegacyReaderMenus());
  stack.defer(() => logger.info("legacy menus torn down"));
  return stack.move();
}
