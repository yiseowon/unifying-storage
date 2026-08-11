import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Unifying Storage",
  description: "개인 파일 서버",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
