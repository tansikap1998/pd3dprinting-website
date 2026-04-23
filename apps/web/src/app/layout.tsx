import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PB3D Printing",
  description: "3D Printing Cost Hub",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
