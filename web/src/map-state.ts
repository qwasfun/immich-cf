import { mapViews, mercatorLatitude, type MapView } from '../../src/geo';
import { photoQuery, photoQueryParams, type PhotoQuery } from '../../src/web/gallery-query';

export interface MapSaved {
  center: [number, number];
  zoom: number;
  mapView: MapView;
  albumId: string;
  basemap: boolean;
  query: PhotoQuery;
}
// Share the account-scoped prefix so logout/account changes clear map and timeline records together.
const prefix = 'immich-cf-timeline:';
export function readMap(owner: string, entry: string): MapSaved | null {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(`${prefix}${owner}:map:${entry}`) ??
        sessionStorage.getItem(`${prefix}${owner}:map:latest`) ??
        'null',
    );
    if (
      !saved ||
      sessionStorage.getItem(prefix + 'owner') !== owner ||
      !Array.isArray(saved.center) ||
      saved.center.length !== 2 ||
      !saved.center.every(Number.isFinite) ||
      Math.abs(saved.center[0]) > mercatorLatitude ||
      Math.abs(saved.center[1]) > 180 ||
      !Number.isInteger(saved.zoom) ||
      saved.zoom < 0 ||
      saved.zoom > 19 ||
      !mapViews.includes(saved.mapView) ||
      typeof saved.albumId !== 'string' ||
      (saved.mapView === 'album' ? !/^[a-f0-9-]{36}$/.test(saved.albumId) : !!saved.albumId) ||
      !saved.query ||
      typeof saved.query !== 'object'
    )
      return null;
    return {
      ...saved,
      basemap: typeof saved.basemap === 'boolean' ? saved.basemap : true,
      query: photoQuery(photoQueryParams(saved.query)),
    };
  } catch {
    return null;
  }
}
export function saveMap(owner: string, entry: string, saved: MapSaved) {
  try {
    if (sessionStorage.getItem(prefix + 'owner') !== owner) return;
    const value = JSON.stringify(saved);
    sessionStorage.setItem(`${prefix}${owner}:map:${entry}`, value);
    sessionStorage.setItem(`${prefix}${owner}:map:latest`, value);
    const entries = Object.keys(sessionStorage).filter(
      (key) => key.startsWith(prefix + owner + ':map:') && !key.endsWith(':latest'),
    );
    for (const key of entries.slice(0, Math.max(0, entries.length - 30)))
      sessionStorage.removeItem(key);
  } catch {
    /* Optional tab storage; the current map still works without it. */
  }
}
