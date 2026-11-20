import type { Metadata } from "next";
import { Figtree } from "next/font/google";
import "./globals.css";

const figtree = Figtree({ subsets: ["latin", "latin-ext"], variable: "--font-figtree" });

export const metadata: Metadata = {
  title: "Saturday planner",
  description:
    "An agent that turns your city, budget, free time and mood into a checked Saturday plan of real places, and shows how it got there.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={figtree.variable}>
      <body className="min-h-dvh font-sans">{children}</body>
    </html>
  );
}
