export const RED = 63;
export const ORANGE = 64;
export const YELLOW = 65;
export const GREEN = 66;
export const BLUE = 67;
export const VIOLET = 68;
export const WHITE = 69;
export const BLACK = 70;
export const HEART = 62;
export const BLANK = 0;

const PUNCTUATION_CODES: Record<string, number> = {
  "!": 37,
  "@": 38,
  "#": 39,
  "$": 40,
  "(": 41,
  ")": 42,
  "-": 44,
  "+": 46,
  "&": 47,
  "=": 48,
  ";": 49,
  ":": 50,
  "'": 52,
  "\"": 53,
  "%": 54,
  ",": 55,
  ".": 56,
  "/": 59,
  "?": 60,
  "°": 62,
  "♥": HEART
};

const VALID_CHARACTER_CODES = new Set<number>([
  BLANK,
  ...Array.from({ length: 26 }, (_, index) => index + 1),
  ...Array.from({ length: 10 }, (_, index) => index + 27),
  ...Object.values(PUNCTUATION_CODES),
  RED, ORANGE, YELLOW, GREEN, BLUE, VIOLET, WHITE, BLACK
]);

export function isValidCharacterCode(value: number): boolean {
  return Number.isInteger(value) && VALID_CHARACTER_CODES.has(value);
}

export function encode(text: string): number[] {
  return [...text].map(charCode);
}

export function charCode(char: string): number {
  if (char === " ") return BLANK;
  const punctuationCode = PUNCTUATION_CODES[char];
  if (punctuationCode !== undefined) return punctuationCode;

  const code = char.toUpperCase().charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 64;
  if (char >= "1" && char <= "9") return Number(char) + 26;
  if (char === "0") return 36;

  throw new Error(`Unsupported Vestaboard character: ${char}`);
}
