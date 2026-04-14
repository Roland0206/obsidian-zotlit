import { homedir } from "os";
import { join } from "path";
import type { DatabaseOptions, DatabasePaths } from "@obzt/database/api";
import type { OptionalCleanup, Useful } from "@ophidian/core";
import {
  calc,
  SettingsService as _SettingsService,
  getContext,
} from "@ophidian/core";
import type { Component } from "obsidian";
import { getBinaryFullPath } from "@/install-guide/version";
import ZoteroPlugin from "@/zt-main";
import { getDefaultSettings, type Settings } from "./service";

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    "then" in value &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

export function skip<T extends (...args: any[]) => OptionalCleanup>(
  compute: T,
  deps: () => any,
  skipInitial?: boolean,
): (...args: Parameters<T>) => ReturnType<T> | undefined;
export function skip<T extends (...args: any[]) => PromiseLike<unknown>>(
  compute: T,
  deps: () => any,
  skipInitial?: boolean,
): (...args: Parameters<T>) => void;
export function skip<T extends (...args: any[]) => OptionalCleanup | PromiseLike<unknown>>(
  compute: T,
  deps: () => any,
  skipInitial = false,
) {
  let count = 0;
  return (...args: Parameters<T>) => {
    deps();
    if (count++ > (skipInitial ? 1 : 0)) {
      const result = compute(...args);
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch((error: unknown) => {
          console.error("Unhandled async effect in skip()", error);
        });
        return;
      }
      return result;
    }
  };
}

const getDefaultZoteroDataDir = () => join(homedir(), "Zotero");

export class SettingsService extends _SettingsService<Settings> {
  #plugin = this.use(ZoteroPlugin);
  /** cache result */
  #nativeBinding?: string;
  get nativeBinding(): string {
    if (this.#nativeBinding) return this.#nativeBinding;
    const binaryFullPath = getBinaryFullPath();
    if (binaryFullPath) {
      this.#nativeBinding = binaryFullPath;
      return this.#nativeBinding;
    } else throw new Error("Failed to get native binding path");
  }

  @calc get templateDir() {
    return this.current?.template?.folder ?? getDefaultSettings().template.folder;
  }

  @calc get libId() {
    return this.current?.citationLibrary ?? getDefaultSettings().citationLibrary;
  }

  @calc get citationEditorSuggester() {
    return (
      this.current?.citationEditorSuggester ??
      getDefaultSettings().citationEditorSuggester
    );
  }

  @calc get showCitekeyInSuggester() {
    return (
      this.current?.showCitekeyInSuggester ??
      getDefaultSettings().showCitekeyInSuggester
    );
  }

  @calc get simpleTemplates() {
    return (
      this.current?.template?.templates ?? getDefaultSettings().template.templates
    );
  }

  @calc get autoTrim() {
    return this.current?.autoTrim ?? getDefaultSettings().autoTrim;
  }

  @calc get zoteroDataDir(): string {
    return this.current?.zoteroDataDir ?? getDefaultZoteroDataDir();
  }

  @calc get zoteroDbPath(): string {
    return join(this.zoteroDataDir, "zotero.sqlite");
  }

  @calc get bbtSearchDbPath(): string {
    return join(this.zoteroDataDir, "better-bibtex-search.sqlite");
  }

  @calc get bbtMainDbPath(): string {
    return join(this.zoteroDataDir, "better-bibtex.sqlite");
  }

  @calc get zoteroCacheDirPath(): string {
    return join(this.zoteroDataDir, "cache");
  }

  @calc get dbConnParams(): [paths: DatabasePaths, opts: DatabaseOptions] {
    return [
      {
        zotero: this.zoteroDbPath,
        bbtSearch: this.bbtSearchDbPath,
        bbtMain: this.bbtMainDbPath,
      },
      { nativeBinding: this.nativeBinding },
    ];
  }
}

export function useSettings(owner: Component & Partial<Useful>) {
  const svc = getContext(owner)(SettingsService) as SettingsService;
  svc.addDefaults(getDefaultSettings());
  return svc;
}
