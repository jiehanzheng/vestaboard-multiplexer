export {
  BLACK,
  BLANK,
  BLUE,
  charCode,
  encode,
  GREEN,
  HEART,
  ORANGE,
  RED,
  VIOLET,
  WHITE,
  YELLOW
} from "../../../vestaboardCharacters.js";

export function sanitizeDisplayText(message: string): string {
  return sanitizeText(message).replace(/\s+/g, " ").trim();
}

export function sanitizeText(message: string): string {
  return message
    .toUpperCase()
    .replace(/[^A-Z0-9 !@#$()+&=;:'"%.,/?°♥-]/g, " ");
}

export function sanitizeRowText(message: string): string {
  return sanitizeText(message);
}

export function percentLabel(remainingRatio: number): string {
  const percent = Math.round(clamp(remainingRatio) * 100);
  return percent >= 100 ? "100" : `${String(percent).padStart(2, " ")}%`;
}

export function flagshipPercentLabel(remainingRatio: number): string {
  const percent = Math.round(clamp(remainingRatio) * 100);
  return `${percent}%`;
}

export function hhmm(date: Date, timeZone?: string): string {
  const parts = dateParts(date, timeZone);
  return `${parts.hour}${parts.minute}`;
}

export function mmdd(date: Date, timeZone?: string): string {
  const parts = dateParts(date, timeZone);
  return `${parts.month}/${parts.day}`;
}

export function hhmmWithColon(date: Date, timeZone?: string): string {
  const parts = dateParts(date, timeZone);
  return `${parts.hour}:${parts.minute}`;
}

export function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function dateParts(date: Date, timeZone?: string): Record<"month" | "day" | "hour" | "minute", string> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    month: parts.month ?? "00",
    day: parts.day ?? "00",
    hour: parts.hour === "24" ? "00" : (parts.hour ?? "00"),
    minute: parts.minute ?? "00"
  };
}
