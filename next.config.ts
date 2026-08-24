import type { NextConfig } from "next";

const config: NextConfig = {
  // Traces the runtime files into .next/standalone, which is what keeps the shipped
  // image small enough that self-hosting is a download rather than a project.
  output: "standalone",
};

export default config;
