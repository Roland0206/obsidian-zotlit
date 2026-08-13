import { execFile } from "node:child_process";
import { FileSystemAdapter, Notice, normalizePath } from "obsidian";
import type { Vault } from "obsidian";

import type { Attachment, Item } from "@zotlit/db";
import { attachmentAbsPath } from "@zotlit/db/path";

import { getLogger } from "@/lib/log";
import type { Settings } from "@/services/settings/schema";
import type { ZoteroPrefService } from "@/services/zotero-pref/service";

const logger = getLogger("adapter-placement");
export interface AdapterPlacementContract {
  state: "ready" | "fallback";
  mode: "canonical_bundle" | "staging_inbox";
  paths: {
    sourceNote?: string | null;
    pdf?: string | null;
    sourceResources?: string | null;
  };
  permissions?: {
    writeSourceNote?: boolean;
    overwriteSourceNote?: boolean;
    writeSourceResources?: boolean;
    writeSummary?: boolean;
  };
  artifactBundleFrontmatter?: Record<string, unknown> | null;
  fallback?: { reasons?: string[] } | null;
}

export async function resolveAdapterPlacement({
  app,
  settings,
  item,
  pdfPath,
}: {
  app: { vault: Pick<Vault, "adapter"> };
  settings: Readonly<Settings>;
  item: Item;
  pdfPath?: string | null;
}): Promise<AdapterPlacementContract | null> {
  if (!settings["lit-management.placement-enabled"]) return null;
  const vaultRoot = vaultBasePath(app);
  if (!vaultRoot) {
    new Notice(
      "lit-management placement unavailable: vault path is not a filesystem path",
    );
    return null;
  }

  const request = {
    schemaVersion: 1,
    adapter: "zotlit",
    action: "upsert_source",
    roles: ["source_note", "pdf", "source_resources"],
    identityFacts: {
      citekey: firstStringField(item.fields, "citationKey") ?? item.key,
      title: itemTitle(item),
      authors: item.creators.map(creatorName).filter((name) => name !== null),
      year: itemYear(item),
      doi: firstStringField(item.fields, "DOI", "doi"),
      arxivId: firstStringField(item.fields, "arxivId", "arxivID", "arxiv"),
      zoteroItemKey: item.key,
    },
    pdf: pdfPath ? { path: pdfPath } : undefined,
  };

  try {
    const stdout = await execPlacement({
      command: settings["lit-management.command"],
      args: [
        "adapter-placement",
        "--config",
        settings["lit-management.config"],
      ],
      input: JSON.stringify(request),
      cwd: vaultRoot,
    });
    return JSON.parse(stdout) as AdapterPlacementContract;
  } catch (error) {
    logger.warn("lit-management adapter-placement failed", { error });
    new Notice("lit-management placement failed; ZotLit default path used");
    return null;
  }
}

export function contractSourcePath(
  contract: AdapterPlacementContract | null,
): string | null {
  const path = contract?.paths?.sourceNote;
  return typeof path === "string" && path.trim() ? normalizePath(path) : null;
}

export function contractFrontmatter(
  contract: AdapterPlacementContract | null,
): Record<string, unknown> | undefined {
  const bundle = contract?.artifactBundleFrontmatter;
  if (!bundle) return undefined;
  return {
    generated_by: "lit-management",
    source_note_stub: true,
    artifact_bundle: bundle,
  };
}

export function firstPdfAttachmentPath(
  attachments: readonly Attachment[],
  zoteroPref: Pick<ZoteroPrefService, "dataDir" | "baseAttachmentPath">,
): string | null {
  for (const attachment of attachments) {
    if (!isPdfAttachment(attachment)) continue;
    const path = attachmentAbsPath(attachment, {
      dataDir: zoteroPref.dataDir,
      baseAttachmentPath: zoteroPref.baseAttachmentPath,
    });
    if (path) return path;
  }
  return null;
}

function isPdfAttachment(attachment: Attachment): boolean {
  return (
    attachment.contentType === "application/pdf" ||
    attachment.path?.toLowerCase().endsWith(".pdf") === true
  );
}

function execPlacement({
  command,
  args,
  input,
  cwd,
}: {
  command: string;
  args: string[];
  input: string;
  cwd: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr}`));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(input);
  });
}

function vaultBasePath(app: { vault: Pick<Vault, "adapter"> }): string | null {
  const adapter = app.vault.adapter;
  if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
  return null;
}

function creatorName(creator: {
  firstName?: string | null;
  lastName?: string | null;
}): string | null {
  const name = [creator.firstName, creator.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || null;
}

function itemTitle(item: Item): string {
  return (
    firstStringField(item.fields, "title") ??
    firstStringField(item.fields, "citationKey") ??
    item.key
  );
}

function itemYear(item: Item): number | null {
  const raw = firstStringField(item.fields, "date", "year");
  const match = raw?.match(/\d{4}/u);
  return match ? Number.parseInt(match[0], 10) : null;
}

function firstStringField(record: object, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = (record as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
