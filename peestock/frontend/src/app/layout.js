import "./globals.css";

export const metadata = {
  title: "PEESTOCK — Predictive Technical Analysis Platform",
  description:
    "Advanced chart pattern screener, no-code scanners, automated trendlines, and visual backtesting for NSE stocks.",
  keywords: "stock screener, technical analysis, chart patterns, NSE, trendlines, backtesting",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
