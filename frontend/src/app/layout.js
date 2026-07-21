import "./globals.css";

export const metadata = {
  title: "Chartix — AI-Powered Technical Analysis Platform",
  description:
    "Advanced chart pattern screener, no-code scanners, automated trendlines, and visual backtesting for NSE stocks.",
  keywords: "stock screener, technical analysis, chart patterns, NSE, trendlines, backtesting",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
