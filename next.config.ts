import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Weekly report uploads can be a few MB.
    serverActions: { bodySizeLimit: "25mb" },
  },
  serverExternalPackages: ["exceljs"],
};

export default nextConfig;
