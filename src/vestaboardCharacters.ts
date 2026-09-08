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

export type VestaboardBoardKind = "note" | "flagship";

export interface VestaboardCharacterOption {
  code: number;
  name: string;
  display: { note: string; flagship: string };
}

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

/**
 * The local API accepts these codes. Keeping the catalog data-only makes it
 * safe for both the Node renderer and the browser settings editor to share.
 * Code 62 has two board glyphs; it is the red Heart on Note and Degree on
 * Flagship, as documented by Vestaboard.
 */
export const VESTABOARD_CHARACTER_CATALOG: readonly VestaboardCharacterOption[] = [
  { code: BLANK, name: "Blank", display: { note: "", flagship: "" } },
  ...Array.from({ length: 26 }, (_, index) => {
    const letter = String.fromCharCode(65 + index);
    return { code: index + 1, name: letter, display: { note: letter, flagship: letter } };
  }),
  ...[
    [27, "One", "1"], [28, "Two", "2"], [29, "Three", "3"], [30, "Four", "4"], [31, "Five", "5"],
    [32, "Six", "6"], [33, "Seven", "7"], [34, "Eight", "8"], [35, "Nine", "9"], [36, "Zero", "0"],
    [37, "Exclamation Mark", "!"], [38, "At", "@"], [39, "Pound", "#"], [40, "Dollar", "$"],
    [41, "Left Parenthesis", "("], [42, "Right Parenthesis", ")"], [44, "Hyphen", "-"], [46, "Plus", "+"],
    [47, "Ampersand", "&"], [48, "Equal", "="], [49, "Semicolon", ";"], [50, "Colon", ":"],
    [52, "Single Quote", "'"], [53, "Double Quote", "\""], [54, "Percent", "%"], [55, "Comma", ","],
    [56, "Period", "."], [59, "Slash", "/"], [60, "Question Mark", "?"],
  ].map(([code, name, display]) => ({
    code: code as number,
    name: name as string,
    display: { note: display as string, flagship: display as string }
  })),
  { code: 62, name: "Degree / Heart", display: { note: "♥", flagship: "°" } },
  { code: RED, name: "Red", display: { note: "", flagship: "" } },
  { code: ORANGE, name: "Orange", display: { note: "", flagship: "" } },
  { code: YELLOW, name: "Yellow", display: { note: "", flagship: "" } },
  { code: GREEN, name: "Green", display: { note: "", flagship: "" } },
  { code: BLUE, name: "Blue", display: { note: "", flagship: "" } },
  { code: VIOLET, name: "Violet", display: { note: "", flagship: "" } },
  { code: WHITE, name: "White", display: { note: "", flagship: "" } },
  { code: BLACK, name: "Black", display: { note: "", flagship: "" } }
];

const VALID_CHARACTER_CODES = new Set(VESTABOARD_CHARACTER_CATALOG.map(({ code }) => code));

export function isValidCharacterCode(value: number): boolean {
  return Number.isInteger(value) && VALID_CHARACTER_CODES.has(value);
}

export function characterOption(code: number): VestaboardCharacterOption | undefined {
  return VESTABOARD_CHARACTER_CATALOG.find((option) => option.code === code);
}

export function characterDisplay(code: number, board: VestaboardBoardKind = "note"): string {
  return characterOption(code)?.display[board] ?? "";
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
