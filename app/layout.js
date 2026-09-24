import "./globals.css";

export const metadata = {
  title: "Consensus Lab Cloud",
  description: "Cloud BTC paper-trading research engine",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
