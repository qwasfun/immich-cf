// Frozen v3.3.1 server/src/utils/preferences.ts defaults (UTC).
// Preferences describe user choices, not server feature availability.
export function defaultPreferences() {
  return {
    albums: { defaultAssetOrder: 'desc' },
    folders: { enabled: false, sidebarWeb: false },
    memories: { enabled: true, duration: 5, sidebarWeb: false },
    people: { enabled: true, sidebarWeb: false, minimumFaces: 3, updateStrategy: 'everyone' },
    sharedLinks: { enabled: true, sidebarWeb: false },
    ratings: { enabled: false },
    tags: { enabled: false, sidebarWeb: false },
    emailNotifications: { enabled: true, albumInvite: true, albumUpdate: true },
    download: { archiveSize: 4 * 1024 ** 3, includeEmbeddedVideos: false },
    purchase: { showSupportBadge: true, hideBuyButtonUntil: '2022-02-12T00:00:00.000Z' },
    cast: { gCastEnabled: false },
    recentlyAdded: { sidebarWeb: false },
  };
}
