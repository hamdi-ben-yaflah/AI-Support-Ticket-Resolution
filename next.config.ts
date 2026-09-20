import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  deploymentId: process.env.APP_VERSION,
};

export default nextConfig;
