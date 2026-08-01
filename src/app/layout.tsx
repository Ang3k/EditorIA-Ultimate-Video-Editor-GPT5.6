import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EditorIA",
  description: "Editor de vídeo automático guiado por narração.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
