import { promises } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const { copyFile, rename, writeFile } = promises;
const appDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * @param {{ hotreload?: boolean, beta?:boolean }} config
 * @returns {import("esbuild").Plugin}
 */
const obPlugin = (config = {}) => ({
  name: "obsidian-plugin",
  setup: (build) => {
    const { hotreload = true, beta = false } = config;
    build.onEnd(async () => {
      const outDir = dirname(build.initialOptions.outfile ?? "main.js");
      // fix default css output file name
      const { outfile } = build.initialOptions;
      try {
        await rename(
          outfile.replace(/\.js$/, ".css"),
          outfile.replace(/main\.js$/, "styles.css"),
        );
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }

      // copy manifest.json to build dir
      if (!beta) {
        await copyFile(join(appDir, "manifest.json"), join(outDir, "manifest.json"));
      } else {
        await copyFile(join(appDir, "manifest-beta.json"), join(outDir, "manifest.json"));
      }

      // create .hotreload if it doesn't exist
      if (hotreload) {
        try {
          await writeFile(join(outDir, ".hotreload"), "", { flag: "wx" });
        } catch (err) {
          if (err.code !== "EEXIST") throw err;
        }
      }

      console.log("build finished");
    });
  },
});
export default obPlugin;
