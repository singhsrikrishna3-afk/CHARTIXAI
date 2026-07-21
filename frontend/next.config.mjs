/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  async redirects() {
    return [
      {
        source: "/api/docs",
        destination: "http://localhost:8000/docs",
        permanent: false,
      },
      {
        source: "/docs",
        destination: "http://localhost:8000/docs",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
