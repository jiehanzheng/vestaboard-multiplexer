import type { ConfigSection } from "./draftState";

export type NoticeTone = "success" | "warning" | "error" | "info";
export type NoticeScope = ConfigSection | "runtime";
export type Notice = {
  tone: NoticeTone;
  message: string;
  section?: NoticeScope;
} | undefined;
