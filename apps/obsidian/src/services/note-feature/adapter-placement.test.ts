import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { FileSystemAdapter } from "obsidian";
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
    schemaVersion: 1,
    adapter: "zotlit",
    action: "upsert_source",
    state: "ready",
    mode: "canonical_bundle",
    paths: {
      sourceNote: "library/key--frozen/Source - key.md",
      pdf: "library/key--frozen/attachments/key.pdf",
    },
    permissions: {
      writeSourceNote: true,
      overwriteSourceNote: false,
      copyPdf: false,
    },
  };
}

describe("adapter placement boundary", () => {
  it.each([
    "invalid json",
    JSON.stringify({ schemaVersion: 2 }),
    JSON.stringify({ state: "fallback" }),
  ])(
    "stops creation rather than using an inbox on invalid engine response %s",
    async (stdout) => {
      vi.mocked(execFile).mockImplementation((...args) => {
        const callback = args.at(-1) as (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void;
        queueMicrotask(() => callback(null, stdout, ""));
        return { stdin: { end: vi.fn() } } as unknown as ChildProcess;
      });
      const app = {
        vault: {
          adapter: Object.assign(new FileSystemAdapter(), {
            getBasePath: () => "/vault",
          }),
        },
      };
      await expect(
        resolveAdapterPlacement({
          app,
          settings: { ...defaults, "lit-management.placement-enabled": true },
          item: {
            key: "ROOT1234",
            fields: { citationKey: "root" },
            creators: [],
          } as unknown as Item,
        }),
      ).rejects.toThrow("note creation stopped");
    },
  );

  it("uses the configured engine argv and preserves the versioned contract", async () => {
    const end = vi.fn();
    vi.mocked(execFile).mockImplementation((...args) => {
      const callback = args.at(-1) as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      queueMicrotask(() => callback(null, JSON.stringify(readyContract()), ""));
      return { stdin: { end } } as unknown as ChildProcess;
    });
    const result = await resolveAdapterPlacement({
      app: {
        vault: {
          adapter: Object.assign(new FileSystemAdapter(), {
            getBasePath: () => "/vault",
          }),
        },
      },
      settings: {
        ...defaults,
        "lit-management.placement-enabled": true,
        "lit-management.command": "/engine/bin/lit-management",
        "lit-management.config": "/vault/config.yaml",
      },
      item: {
        key: "ROOT1234",
        fields: { citationKey: "root" },
        creators: [],
      } as unknown as Item,
    });
    expect(execFile).toHaveBeenCalledWith(
      "/engine/bin/lit-management",
      ["adapter-placement", "--config", "/vault/config.yaml"],
      { cwd: "/vault", timeout: 30_000 },
      expect.any(Function),
    );
    expect(JSON.parse(end.mock.calls[0]![0])).toMatchObject({
      schemaVersion: 1,
      identityFacts: { zoteroItemKey: "ROOT1234", citekey: "root" },
    });
    expect(contractSourcePath(result)).toBe(
      "library/key--frozen/Source - key.md",
    );
  });

  it("accepts a versioned create-only contract without changing frozen paths", () => {
    const contract = parseAdapterPlacementContract(readyContract());
    expect(contractSourcePath(contract)).toBe(
      "library/key--frozen/Source - key.md",
    );
    expect(contract.paths.pdf).toBe("library/key--frozen/attachments/key.pdf");
    expect(contract.permissions?.copyPdf).toBe(false);
  });

  it.each([undefined, 0, 2, "1"])(
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
        paths: { sourceNote },
      }),
    ).toThrow();
  });

  it("rejects an unsafe PDF path even when source path is valid", () => {
    const contract = readyContract();
    contract.paths.pdf = "../../outside.pdf";
    expect(() => parseAdapterPlacementContract(contract)).toThrow();
  });
});
