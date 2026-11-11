import { useEffect, useRef } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { mercatorLatitude, wrapLongitude, type GeoBounds, type GeoCluster } from '../../src/geo';

export interface MapPosition {
  center: [number, number];
  zoom: number;
}
export interface MapViewport extends MapPosition {
  bounds: GeoBounds;
}
export function MapCanvas({
  position,
  clusters,
  fit,
  basemap,
  retry,
  moved,
  select,
  tileError,
}: {
  position: MapPosition;
  clusters: GeoCluster[];
  fit: { bounds: GeoBounds; nonce: number } | null;
  basemap: boolean;
  retry: number;
  moved: (viewport: MapViewport) => void;
  select: (cluster: GeoCluster) => void;
  tileError: () => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    map = useRef<L.Map | null>(null),
    markers = useRef<L.LayerGroup | null>(null),
    tiles = useRef<L.TileLayer | null>(null);
  const initial = useRef(position),
    callbacks = useRef({ moved, select, tileError });
  callbacks.current = { moved, select, tileError };
  useEffect(() => {
    const instance = L.map(root.current!, {
      center: initial.current.center,
      zoom: initial.current.zoom,
      minZoom: 0,
      maxZoom: 19,
      worldCopyJump: true,
      scrollWheelZoom: false,
      zoomControl: false,
      zoomAnimation: false,
      fadeAnimation: false,
      markerZoomAnimation: false,
    });
    map.current = instance;
    L.control.zoom({ zoomInTitle: '放大地图', zoomOutTitle: '缩小地图' }).addTo(instance);
    markers.current = L.layerGroup().addTo(instance);
    const move = () => {
      const bounds = instance.getBounds(),
        center = instance.getCenter();
      callbacks.current.moved({
        center: [
          Math.max(-mercatorLatitude, Math.min(mercatorLatitude, center.lat)),
          wrapLongitude(center.lng),
        ],
        zoom: instance.getZoom(),
        bounds: {
          south: bounds.getSouth() <= -mercatorLatitude ? -90 : Math.max(-90, bounds.getSouth()),
          north: bounds.getNorth() >= mercatorLatitude ? 90 : Math.min(90, bounds.getNorth()),
          west: bounds.getEast() - bounds.getWest() >= 360 ? -180 : wrapLongitude(bounds.getWest()),
          east: bounds.getEast() - bounds.getWest() >= 360 ? 180 : wrapLongitude(bounds.getEast()),
        },
      });
    };
    instance.on('moveend', move);
    move();
    const observer = new ResizeObserver(() => instance.invalidateSize({ pan: false }));
    observer.observe(root.current!);
    return () => {
      observer.disconnect();
      instance.remove();
      map.current = null;
      markers.current = null;
      tiles.current = null;
    };
  }, []);
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    if (basemap) {
      const layer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        crossOrigin: 'anonymous',
        referrerPolicy: 'strict-origin-when-cross-origin',
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
        updateWhenIdle: true,
        keepBuffer: 1,
      });
      layer.on('tileerror', () => callbacks.current.tileError());
      layer.addTo(instance);
      tiles.current = layer;
      return () => {
        layer.remove();
        tiles.current = null;
      };
    }
  }, [basemap, retry]);
  useEffect(() => {
    const instance = map.current,
      group = markers.current;
    if (!instance || !group) return;
    group.clearLayers();
    for (const cluster of clusters) {
      const longitude =
        cluster.longitude + 360 * Math.round((instance.getCenter().lng - cluster.longitude) / 360);
      const size = cluster.count >= 1000 ? 52 : 42;
      const marker = L.marker(
        [Math.max(-mercatorLatitude, Math.min(mercatorLatitude, cluster.latitude)), longitude],
        {
          icon: L.divIcon({
            className: 'photo-map-pin',
            html: `<span>${cluster.count}</span>`,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
          }),
          title: `${cluster.count} 张照片，纬度 ${cluster.latitude.toFixed(5)}，经度 ${cluster.longitude.toFixed(5)}`,
          keyboard: true,
          autoPanOnFocus: false,
        },
      );
      marker.on('click', () => callbacks.current.select(cluster));
      marker.addTo(group);
      marker.getElement()?.setAttribute('aria-label', marker.options.title!);
    }
  }, [clusters, position.center[1]]);
  useEffect(() => {
    if (!fit || !map.current) return;
    const { south, north, west, east } = fit.bounds;
    map.current.fitBounds(
      [
        [Math.max(-mercatorLatitude, south), west],
        [Math.min(mercatorLatitude, north), east < west ? east + 360 : east],
      ],
      { padding: [36, 36], maxZoom: 17, animate: false },
    );
  }, [fit]);
  return (
    <div
      ref={root}
      className="photo-map-canvas"
      role="region"
      aria-label="照片地图"
      aria-describedby="map-interaction-hint"
    />
  );
}
