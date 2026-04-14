/** Build-time constants injected by esbuild define (see esbuild.config.mjs). */

declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * Semver of the resolved better-sqlite3 package, without the leading "v".
     * e.g. "12.8.0". Injected from node_modules/better-sqlite3/package.json.
     */
    BETTER_SQLITE3_VERSION: string;
  }
}

/**
 * Map of {@link NodeJS.Process.versions.modules} → platform → supported
 * architectures, auto-derived from the WiseLibs release assets for the
 * resolved better-sqlite3 version at build time. Empty `{}` in dev builds
 * — runtime helpers treat an empty map as "pre-flight bypassed".
 */
declare const BETTER_SQLITE3_SUPPORT: Record<string, Record<string, string[]>>;
declare const PATCHED_BUILD_COMMIT: string;
declare const PATCHED_BUILD_REPO_URL: string;
declare const PATCHED_BUILD_RELEASE_URL: string;
declare const PATCHED_BUILD_LATEST_API_URL: string;
