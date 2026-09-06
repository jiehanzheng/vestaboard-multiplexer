import { z } from "zod";

export const HttpUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch { return false; }
}, "must be a valid HTTP(S) URL without embedded credentials");
