import { execFile } from "node:child_process";
import { dirname } from "node:path/posix";
import { FileSystemAdapter, normalizePath } from "obsidian";
import type { Vault } from "obsidian";
import * as v from "valibot";

import type { Attachment, Item } from "@zotlit/db";
import { attachmentAbsPath } from "@zotlit/db/path";

import { getLogger } from "@/lib/log";
import { attachmentSourceOrigin } from "@/services/attachment-import/service";
import type { SourceOrigin } from "@/services/attachment-import/service";
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
    copyPdf?: boolean;
    writeSourceNote?: boolean;
    overwriteSourceNote?: boolean;
    writeSourceResources?: boolean;
    writeSummary?: boolean;
  };
  artifactBundleFrontmatter?: Record<string, unknown> | null;
  fallback?: { reasons?: string[] } | null;
}

const vaultRelativePath = v.pipe(
  v.string(),
  v.check(
    (path) =>
      path.length > 0 &&
      !path.includes("\\") &&
      !path.includes(":") &&
      !path.includes("\0") &&
      path
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Placement path must be vault-relative without traversal",
  ),
);

const placementSchema = v.object({
  schemaVersion: v.literal(1),
  adapter: v.literal("zotlit"),
  action: v.literal("upsert_source"),
  state: v.literal("ready"),
  mode: v.literal("canonical_bundle"),
  paths: v.object({
    sourceNote: vaultRelativePath,
    pdf: v.optional(v.nullable(vaultRelativePath)),
    sourceResources: v.optional(v.nullable(vaultRelativePath)),
  }),
  permissions: v.object({
    writeSourceNote: v.literal(true),
    overwriteSourceNote: v.literal(false),
    copyPdf: v.optional(v.boolean()),
    writeSourceResources: v.optional(v.boolean()),
    writeSummary: v.optional(v.literal(false)),
  }),
  artifactBundleFrontmatter: v.optional(
    v.nullable(v.record(v.string(), v.unknown())),
  ),
});

export function parseAdapterPlacementContract(
  value: unknown,
): AdapterPlacementContract {
  return v.parse(placementSchema, value);
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
    throw new Error(
      "lit-management placement unavailable: vault path is not a filesystem path",
    );
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
    return parseAdapterPlacementContract(JSON.parse(stdout));
  } catch (error) {
    logger.warn("lit-management adapter-placement failed", { error });
    throw new Error("lit-management placement failed; note creation stopped", {
      cause: error,
    });
  }
}

export function contractSourcePath(
  contract: AdapterPlacementContract | null,
): string | null {
  if (contract === null) return null;
  if (
    contract.state !== "ready" ||
    contract.mode !== "canonical_bundle" ||
    contract.permissions?.writeSourceNote !== true ||
    contract.permissions.overwriteSourceNote !== false
  ) {
    throw new Error(
      "lit-management placement requires create-only Source Note permission",
    );
  }
  return normalizePath(v.parse(vaultRelativePath, contract.paths?.sourceNote));
}

export function contractPdfPath(
  contract: AdapterPlacementContract | null,
): string | null {
  if (contract?.state !== "ready" || contract.permissions?.copyPdf !== true) {
    return null;
  }
  const path = contract.paths?.pdf;
  return typeof path === "string" && path.trim() ? normalizePath(path) : null;
}

export function contractPdfFolderPath(
  contract: AdapterPlacementContract | null,
): string | undefined {
  if (contract?.state !== "ready" || contract.permissions?.copyPdf !== true) {
    return undefined;
  }
  const path = contractPdfPath(contract);
  return path ? dirname(path) : undefined;
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

export interface PdfAttachmentSource {
  path: string;
  origin: SourceOrigin;
}

export function firstPdfAttachmentSource(
  attachments: readonly Attachment[],
  zoteroPref: Pick<ZoteroPrefService, "dataDir" | "baseAttachmentPath">,
): PdfAttachmentSource | null {
  for (const attachment of attachments) {
    if (!isPdfAttachment(attachment)) continue;
    const origin = attachmentSourceOrigin(attachment);
    if (!origin) continue;
    const path = attachmentAbsPath(attachment, {
      dataDir: zoteroPref.dataDir,
      baseAttachmentPath: zoteroPref.baseAttachmentPath,
    });
    if (path) return { path, origin };
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
