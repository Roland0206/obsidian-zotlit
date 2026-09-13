import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { FileSystemAdapter } from "obsidian";
import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import type { Item } from "@zotlit/db";

import { defaults } from "@/services/settings/schema";

import {
  contractSourcePath,
  parseAdapterPlacementContract,
  resolveAdapterPlacement,
} from "./adapter-placement";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

function readyContract() {
  return {
    schemaVersion: 2,
    adapter: "zotlit",
    action: "upsert_source",
    state: "ready",
    mode: "canonical_bundle",
    decisionHash: "decision-hash",
    paths: {
      bundle: "library/key--frozen",
      sourceNote: "library/key--frozen/Source - key.md",
      pdf: "library/key--frozen/attachments/key.pdf",
      sourceResources: "library/key--frozen/resources/source",
    },
    permissions: {
      writeSourceNote: true,
      overwriteSourceNote: false,
      copyPdf: false,
      writeSourceResources: true,
      writeSummary: false,
    },
  };
}

function reviewContract() {
  return {
    schemaVersion: 2,
    adapter: "zotlit",
    action: "upsert_source",
    state: "review_required",
    mode: "canonical_bundle",
    decisionHash: "decision-hash",
    paths: {
      bundle: null,
      sourceNote: null,
      pdf: null,
      sourceResources: null,
    },
    permissions: {
      writeSourceNote: false,
      overwriteSourceNote: false,
      copyPdf: false,
      writeSourceResources: false,
      writeSummary: false,
    },
    proposal: {
      decisionHash: "decision-hash",
      storageSlug: "key-frozen",
      paths: {
        bundle: "library/key--frozen",
        sourceNote: "library/key--frozen/Source - key.md",
        pdf: "library/key--frozen/attachments/key.pdf",
        sourceResources: "library/key--frozen/resources/source",
      },
    },
  };
}

function blockedContract() {
  return {
    schemaVersion: 2,
    adapter: "zotlit",
    action: "upsert_source",
    state: "blocked",
    mode: "canonical_bundle",
    decisionHash: "blocked-hash",
    paths: {
      bundle: null,
      sourceNote: null,
      pdf: null,
      sourceResources: null,
    },
    permissions: {
      writeSourceNote: false,
      overwriteSourceNote: false,
      copyPdf: false,
      writeSourceResources: false,
      writeSummary: false,
    },
    blockers: ["selected PDF is already registered under another citekey"],
    conflicts: [{ kind: "registered_pdf_hash", citekey: "OldKey2024" }],
  };
}

function appFixture(): App {
  return {
    vault: {
      adapter: Object.assign(new FileSystemAdapter(), {
        getBasePath: () => "/vault",
      }),
    },
  } as unknown as App;
}

function itemFixture(): Item {
  return {
    key: "ROOT1234",
    fields: { citationKey: "root" },
    creators: [],
  } as unknown as Item;
}

function mockPlacementOutputs(...outputs: string[]): {
  end: ReturnType<typeof vi.fn>;
} {
  const end = vi.fn();
  vi.mocked(execFile).mockImplementation((...args) => {
    const callback = args.at(-1) as (
      error: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    const stdout = outputs.shift();
    queueMicrotask(() => callback(null, stdout ?? "", ""));
    return { stdin: { end } } as unknown as ChildProcess;
  });
  return { end };
}

describe("adapter placement boundary", () => {
  it.each([
    "invalid json",
    JSON.stringify({ schemaVersion: 1 }),
    JSON.stringify({ state: "fallback" }),
  ])(
    "stops creation rather than using an inbox on invalid engine response %s",
    async (stdout) => {
      mockPlacementOutputs(stdout);
      await expect(
        resolveAdapterPlacement({
          app: appFixture(),
          settings: { ...defaults, "lit-management.placement-enabled": true },
          item: itemFixture(),
          reviewPlacement: vi.fn(),
        }),
      ).rejects.toThrow("note creation stopped");
    },
  );

  it("reviews and retries one hash-bound canonical placement", async () => {
    const { end } = mockPlacementOutputs(
      JSON.stringify(reviewContract()),
      JSON.stringify(readyContract()),
    );
    const reviewPlacement = vi.fn().mockResolvedValue(true);

    const result = await resolveAdapterPlacement({
      app: appFixture(),
      settings: {
        ...defaults,
        "lit-management.placement-enabled": true,
        "lit-management.command": "/engine/bin/lit-management",
        "lit-management.config": "/vault/config.yaml",
      },
      item: itemFixture(),
      reviewPlacement,
    });

    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenCalledWith(
      "/engine/bin/lit-management",
      ["adapter-placement", "--config", "/vault/config.yaml"],
      { cwd: "/vault", timeout: 30_000 },
      expect.any(Function),
    );
    expect(JSON.parse(end.mock.calls[0]![0])).toMatchObject({
      schemaVersion: 2,
      identityFacts: { zoteroItemKey: "ROOT1234", citekey: "root" },
    });
    expect(JSON.parse(end.mock.calls[1]![0])).toMatchObject({
      placementApproval: {
        decisionHash: "decision-hash",
        reviewer: "zotlit:user",
      },
    });
    expect(reviewPlacement).toHaveBeenCalledWith(
      expect.anything(),
      reviewContract().proposal,
    );
    expect(contractSourcePath(result)).toBe(
      "library/key--frozen/Source - key.md",
    );
  });

  it("stops creation when the placement review is cancelled", async () => {
    mockPlacementOutputs(JSON.stringify(reviewContract()));

    await expect(
      resolveAdapterPlacement({
        app: appFixture(),
        settings: { ...defaults, "lit-management.placement-enabled": true },
        item: itemFixture(),
        reviewPlacement: vi.fn().mockResolvedValue(false),
      }),
    ).rejects.toThrow("note creation stopped");
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("stops creation without review when the engine reports a conflict", async () => {
    mockPlacementOutputs(JSON.stringify(blockedContract()));
    const reviewPlacement = vi.fn();

    await expect(
      resolveAdapterPlacement({
        app: appFixture(),
        settings: { ...defaults, "lit-management.placement-enabled": true },
        item: itemFixture(),
        reviewPlacement,
      }),
    ).rejects.toThrow("note creation stopped");
    expect(reviewPlacement).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("accepts a versioned create-only contract without changing frozen paths", () => {
    const contract = parseAdapterPlacementContract(readyContract());
    expect(contractSourcePath(contract)).toBe(
      "library/key--frozen/Source - key.md",
    );
    expect(contract.paths.pdf).toBe("library/key--frozen/attachments/key.pdf");
    expect(contract.permissions.copyPdf).toBe(false);
  });

  it.each([undefined, 0, 1, "2"])(
    "rejects schema version %s",
    (schemaVersion) => {
      expect(() =>
        parseAdapterPlacementContract({ ...readyContract(), schemaVersion }),
      ).toThrow();
    },
  );

  it.each([
    { state: "fallback", mode: "staging_inbox" },
    { adapter: "unknown" },
    { action: "overwrite_source" },
    { permissions: { writeSourceNote: false, overwriteSourceNote: false } },
    { permissions: { writeSourceNote: true, overwriteSourceNote: true } },
    { permissions: undefined },
    { paths: {} },
  ])("rejects unsupported or unapproved placement %j", (patch) => {
    expect(() =>
      parseAdapterPlacementContract({ ...readyContract(), ...patch }),
    ).toThrow();
  });

  it.each([
    "/outside/note.md",
    "../note.md",
    "library/../note.md",
    "C:/note.md",
    "library\\note.md",
    "library//note.md",
    "library/./note.md",
    "note\0.md",
    "",
  ])("rejects unsafe Source Note path %j", (sourceNote) => {
    expect(() =>
      parseAdapterPlacementContract({
        ...readyContract(),
        paths: { ...readyContract().paths, sourceNote },
      }),
    ).toThrow();
  });

  it("rejects an unsafe proposed bundle path", () => {
    const contract = reviewContract();
    contract.proposal.paths.bundle = "../../outside";
    expect(() => parseAdapterPlacementContract(contract)).toThrow();
  });
});
