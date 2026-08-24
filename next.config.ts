import type { NextConfig } from "next";

const config: NextConfig = {
  // Traces the runtime files into .next/standalone, which is what keeps the shipped
  // image small enough that self-hosting is a download rather than a project.
  output: "standalone",

  // The image optimiser and its platform binaries are 17 MB of the shipped server for
  // a feature the admin does not use. Turning the optimiser off is not enough on its
  // own, since sharp is traced regardless, so it is excluded explicitly. Drop both
  // lines when a page serves images worth resizing.
  images: { unoptimized: true },
  outputFileTracingExcludes: { "*": ["node_modules/@img/**", "node_modules/sharp/**"] },
};

export default config;
