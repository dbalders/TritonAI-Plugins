import { defineConfig } from "vite-plus";

// Paused plugins are kept byte-for-byte for restoration and are not built or checked.
const reviewedDistributionFiles = ["plugins/*/dist/**", "paused/**"];

export default defineConfig({
  fmt: {
    ignorePatterns: reviewedDistributionFiles,
  },
  lint: {
    ignorePatterns: reviewedDistributionFiles,
  },
  test: {
    exclude: ["**/node_modules/**", "**/.git/**", "paused/**"],
  },
});
