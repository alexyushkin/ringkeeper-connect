// Search used across the window (tools, clients): every typed word must
// appear somewhere, ignoring case and accents ("cafe" finds "Café").

function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function matchesWords(haystack: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold(haystack);
  return words.every((w) => hay.includes(w));
}

/** The client list gets a search box once it's this long. */
export const CLIENT_SEARCH_FROM = 6;
