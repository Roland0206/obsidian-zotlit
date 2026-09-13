import { execFile } from "node:child_process";
import { dirname } from "node:path/posix";
import { FileSystemAdapter, Modal, normalizePath, Setting } from "obsidian";
import type { App, Vault } from "obsidian";
import * as v from "valibot";

import type { Attachment, Item } from "@zotlit/db";
import { attachmentAbsPath } from "@zotlit/db/path";

import * as m from "@/lib/i18n/generated/messages";
import { getLogger } from "@/lib/log";
import { attachmentSourceOrigin } from "@/services/attachment-import/service";
import type { SourceOrigin } from "@/services/attachment-import/service";
import type { Settings } from "@/services/settings/schema";
import type { ZoteroPrefService } from "@/services/zotero-pref/service";

const logger = getLogger("adapter-placement");
interface AdapterPlacementPaths {
  bundle?: string | null;
  sourceNote?: string | null;
  pdf?: string | null;
  sourceResources?: string | null;
}

interface AdapterPlacementProposal {
  decisionHash: string;
  storageSlug?: string | null;
  paths: AdapterPlacementPaths;
}

interface AdapterPlacementBase {
  mode: "canonical_bundle";
  decisionHash: string;
  paths: AdapterPlacementPaths;
  permissions: {
    copyPdf: boolean;
    writeSourceNote: boolean;
    overwriteSourceNote: boolean;
    writeSourceResources: boolean;
    writeSummary: false;
  };
  artifactBundleFrontmatter?: Record<string, unknown> | null;
}

export type AdapterPlacementContract = AdapterPlacementBase &
  (
    | { state: "ready"; proposal?: never }
    | { state: "review_required"; proposal: AdapterPlacementProposal }
    | {
        state: "blocked";
        proposal?: never;
        blockers: string[];
        conflicts: unknown[];
      }
  );

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

const optionalPlacementPath = v.optional(v.nullable(vaultRelativePath));
const placementPathsSchema = v.object({
  bundle: optionalPlacementPath,
  sourceNote: optionalPlacementPath,
  pdf: optionalPlacementPath,
  sourceResources: optionalPlacementPath,
});
const readyPlacementSchema = v.object({
  schemaVersion: v.literal(2),
  adapter: v.literal("zotlit"),
  action: v.literal("upsert_source"),
  state: v.literal("ready"),
  mode: v.literal("canonical_bundle"),
  decisionHash: v.string(),
  paths: v.intersect([
    placementPathsSchema,
    v.object({ sourceNote: vaultRelativePath }),
  ]),
  permissions: v.object({
    writeSourceNote: v.literal(true),
    overwriteSourceNote: v.literal(false),
    copyPdf: v.boolean(),
    writeSourceResources: v.boolean(),
    writeSummary: v.literal(false),
  }),
  artifactBundleFrontmatter: v.optional(
    v.nullable(v.record(v.string(), v.unknown())),
  ),
});
const reviewPlacementSchema = v.object({
  schemaVersion: v.literal(2),
  adapter: v.literal("zotlit"),
  action: v.literal("upsert_source"),
  state: v.literal("review_required"),
  mode: v.literal("canonical_bundle"),
  decisionHash: v.string(),
  paths: placementPathsSchema,
  permissions: v.object({
    writeSourceNote: v.literal(false),
    overwriteSourceNote: v.literal(false),
    copyPdf: v.literal(false),
    writeSourceResources: v.literal(false),
    writeSummary: v.literal(false),
  }),
  proposal: v.object({
    decisionHash: v.string(),
    storageSlug: v.optional(v.nullable(v.string())),
    paths: v.intersect([
      placementPathsSchema,
      v.object({
        bundle: vaultRelativePath,
        sourceNote: vaultRelativePath,
      }),
    ]),
  }),
});
const blockedPlacementSchema = v.object({
  schemaVersion: v.literal(2),
  adapter: v.literal("zotlit"),
  action: v.literal("upsert_source"),
  state: v.literal("blocked"),
  mode: v.literal("canonical_bundle"),
  decisionHash: v.string(),
  paths: placementPathsSchema,
  permissions: v.object({
    writeSourceNote: v.literal(false),
    overwriteSourceNote: v.literal(false),
    copyPdf: v.literal(false),
    writeSourceResources: v.literal(false),
    writeSummary: v.literal(false),
  }),
  blockers: v.array(v.string()),
  conflicts: v.array(v.unknown()),
});
const placementSchema = v.variant("state", [
  readyPlacementSchema,
  reviewPlacementSchema,
  blockedPlacementSchema,
]);

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
  approvedDecisionHash,
  reviewPlacement = requestAdapterPlacementReview,
}: {
  app: App & { vault: Pick<Vault, "adapter"> };
  settings: Readonly<Settings>;
  item: Item;
  pdfPath?: string | null;
  approvedDecisionHash?: string;
  reviewPlacement?: (
    app: App,
    proposal: AdapterPlacementProposal,
  ) => Promise<boolean>;
}): Promise<AdapterPlacementContract | null> {
  if (!settings["lit-management.placement-enabled"]) return null;
  const vaultRoot = vaultBasePath(app);
  if (!vaultRoot) {
    throw new Error(
      "lit-management placement unavailable: vault path is not a filesystem path",
    );
  }

  const request = {
    schemaVersion: 2,
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
    const initial = await executePlacementRequest({
      settings,
      request,
      vaultRoot,
    });
    if (initial.state === "ready") return initial;
    if (initial.state === "blocked") {
      throw new Error(initial.blockers.join("; "));
    }
    if (initial.proposal.decisionHash !== initial.decisionHash) {
      throw new Error("lit-management placement proposal hash is inconsistent");
    }
    if (
      approvedDecisionHash !== undefined &&
      approvedDecisionHash !== initial.decisionHash
    ) {
      throw new Error("approved placement decision is stale");
    }
    const approved =
      approvedDecisionHash !== undefined ||
      (await reviewPlacement(app, initial.proposal));
    if (!approved) throw new Error("lit-management placement review cancelled");
    const approvedContract = await executePlacementRequest({
      settings,
      request: {
        ...request,
        placementApproval: {
          decisionHash: initial.decisionHash,
          reviewer: "zotlit:user",
        },
      },
      vaultRoot,
    });
    if (approvedContract.state !== "ready") {
      throw new Error("lit-management did not accept the reviewed placement");
    }
    return approvedContract;
  } catch (error) {
    logger.warn("lit-management adapter-placement failed", { error });
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `lit-management placement failed; note creation stopped${detail}`,
      { cause: error },
    );
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

async function executePlacementRequest({
  settings,
  request,
  vaultRoot,
}: {
  settings: Readonly<Settings>;
  request: object;
  vaultRoot: string;
}): Promise<AdapterPlacementContract> {
  const stdout = await execPlacement({
    command: settings["lit-management.command"],
    args: ["adapter-placement", "--config", settings["lit-management.config"]],
    input: JSON.stringify(request),
    cwd: vaultRoot,
  });
  return parseAdapterPlacementContract(JSON.parse(stdout));
}

async function requestAdapterPlacementReview(
  app: App,
  proposal: AdapterPlacementProposal,
): Promise<boolean> {
  const modal = new AdapterPlacementReviewModal(app, proposal);
  modal.open();
  return modal.result;
}

class AdapterPlacementReviewModal extends Modal {
  readonly #proposal: AdapterPlacementProposal;
  readonly #decision = Promise.withResolvers<boolean>();
  readonly result = this.#decision.promise;
  #settled = false;

  constructor(app: App, proposal: AdapterPlacementProposal) {
    super(app);
    this.#proposal = proposal;
  }

  override onOpen(): void {
    this.setTitle(m.modal_adapter_placement_title());
    this.contentEl.createEl("p", {
      text: m.modal_adapter_placement_description(),
    });
    this.contentEl.createEl("code", {
      text: this.#proposal.paths.bundle ?? "",
    });
    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText(m.modal_adapter_placement_approve())
          .setCta()
          .onClick(() => this.#finish(true)),
      )
      .addButton((button) =>
        button
          .setButtonText(m.modal_adapter_placement_cancel())
          .onClick(() => this.#finish(false)),
      );
  }

  override onClose(): void {
    this.#finish(false, false);
    this.contentEl.empty();
  }

  #finish(value: boolean, close = true): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#decision.resolve(value);
    if (close) this.close();
  }
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
