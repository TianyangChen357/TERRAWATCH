import type { NextConfig } from "next";

const nextConfig: NextConfig =
  process.env.TERRAWATCH_STATIC_EXPORT === "1"
    ? {
        output: "export",
        basePath: process.env.TERRAWATCH_BASE_PATH || undefined,
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {};

export default nextConfig;
