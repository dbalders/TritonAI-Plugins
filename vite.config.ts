import { defineConfig } from "vite-plus";

const reviewedDistributionFiles = ["plugins/*/dist/**"];

export default defineConfig({
  fmt: {
    ignorePatterns: reviewedDistributionFiles,
  },
  lint: {
    ignorePatterns: reviewedDistributionFiles,
  },
});
