import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Food Ambassador",
  description:
    "Food operations management: procurement, inventory, recipes, food safety and traceability.",
};

// Arabic/English localization with RTL support is delivered in Milestone 1;
// until then the shell renders in English only.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" dir="ltr" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
