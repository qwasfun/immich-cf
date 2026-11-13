// Frozen protocol target; this is separate from immich-cf's application version.
// Level 2 enables the official app's passkey flow, which we do not implement.
export const serverVersion = {
  major: 3,
  minor: 4,
  patch: 1,
  prerelease: null,
  featureLevel: 1,
} as const;
