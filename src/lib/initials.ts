// Client-safe on purpose: the header's account menu imports this, so it must
// not reach `src/lib/account.ts`, which pulls in the server-only auth module.

/**
 * One or two letters for the profile button: the first letters of the first
 * and last words of the name, else the first letter of the email.
 */
export function initials(profile: {
  displayName?: string | null;
  email?: string | null;
}): string | null {
  const words = (profile.displayName ?? "").split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? [words[0], words[words.length - 1]]
      : words.length === 1
        ? [words[0]]
        : profile.email
          ? [profile.email]
          : [];
  const out = letters
    .map((w) => Array.from(w)[0] ?? "")
    .join("")
    .toLocaleUpperCase();
  return out || null;
}
