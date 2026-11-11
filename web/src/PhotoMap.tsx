import { useEffect, useRef, useState } from 'react';
import { boundsKey, geoBounds, type GeoBounds, type GeoCluster, type MapView } from '../../src/geo';
import { emptyPhotoQuery, photoQueryParams, hasPhotoFilters } from '../../src/web/gallery-query';
import { api, web, type Album } from './api';
import { readMap, saveMap, type MapSaved } from './map-state';
import { MapCanvas, type MapViewport } from './MapCanvas';
import { PhotoFilters } from './PhotoFilters';
import { Gallery } from './Gallery';
import { Empty, ErrorBox, Icon, Preview } from './ui';

interface MapData {
  version: string;
  total: number;
  visible: number;
  extent: GeoBounds | null;
  zoom: number;
  clusters: GeoCluster[];
}
export default function PhotoMap({
  area,
  mapView: areaView,
  albumId = '',
  ownerId,
  entryKey,
  refresh,
  changed,
  navigate,
}: {
  area?: string;
  mapView?: MapView;
  albumId?: string;
  ownerId: string;
  entryKey: string;
  refresh: number;
  changed: (message: string) => void;
  navigate: (path: string) => void;
}) {
  const [saved] = useState(() => readMap(ownerId, entryKey));
  const [state, setState] = useState<MapSaved>(
    saved ?? {
      center: [20, 0],
      zoom: 2,
      mapView: 'library',
      albumId: '',
      basemap: true,
      query: { ...emptyPhotoQuery },
    },
  );
  const [viewport, setViewport] = useState<MapViewport | null>(null),
    [data, setData] = useState<MapData | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  const [albums, setAlbums] = useState<Album[]>([]),
    [albumError, setAlbumError] = useState('');
  const [selected, setSelected] = useState<GeoCluster | null>(null),
    [tileError, setTileError] = useState(false),
    [tileRetry, setTileRetry] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(!!saved && hasPhotoFilters(saved.query));
  const [fit, setFit] = useState<{ bounds: GeoBounds; nonce: number } | null>(null);
  const needsFit = useRef(!saved),
    current = useRef(state),
    dataScope = useRef('');
  current.current = state;
  const queryKey = photoQueryParams(state.query).toString();
  const scopeKey = `${state.mapView}:${state.albumId}:${queryKey}`;
  const viewportKey = viewport ? boundsKey(viewport.bounds) : '';
  useEffect(() => {
    if (area) return;
    const controller = new AbortController();
    api<{ items: Album[] }>(`${web}/albums`, 'GET', undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setAlbums(result.items);
          setAlbumError('');
        }
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setAlbumError(e.message);
      });
    return () => controller.abort();
  }, [area, refresh, retry]);
  useEffect(() => {
    if (area) return;
    saveMap(ownerId, entryKey, state);
  }, [state, ownerId, entryKey, area]);
  useEffect(() => {
    if (area || !viewport) return;
    if (dataScope.current && dataScope.current !== scopeKey) {
      needsFit.current = true;
      setData(null);
    }
    dataScope.current = scopeKey;
    setSelected(null);
    setLoading(true);
    setError('');
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(photoQueryParams(state.query));
      params.set('mapView', state.mapView);
      params.set('bounds', viewportKey);
      params.set('zoom', String(viewport.zoom));
      if (state.albumId) params.set('albumId', state.albumId);
      api<MapData>(`${web}/map?${params}`, 'GET', undefined, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setData(result);
          if (needsFit.current && result.extent) {
            needsFit.current = false;
            setFit({ bounds: result.extent, nonce: Date.now() });
          }
        })
        .catch((e: Error) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [area, scopeKey, viewportKey, viewport?.zoom, refresh, retry]);
  function moved(next: MapViewport) {
    setViewport((old) =>
      old && boundsKey(old.bounds) === boundsKey(next.bounds) && old.zoom === next.zoom
        ? old
        : next,
    );
    setState((old) =>
      old.zoom === next.zoom && old.center[0] === next.center[0] && old.center[1] === next.center[1]
        ? old
        : { ...old, center: next.center, zoom: next.zoom },
    );
  }
  function show(bounds: GeoBounds) {
    saveMap(ownerId, entryKey, current.current);
    navigate(
      `/map/${state.mapView}/${state.mapView === 'album' ? state.albumId + '/' : ''}${encodeURIComponent(boundsKey(bounds))}`,
    );
  }
  if (area) {
    let bounds: GeoBounds;
    try {
      bounds = geoBounds(area.replace(/%2c/gi, ',').replace(/%2b/gi, '+'));
    } catch (e) {
      return <ErrorBox error={(e as Error).message} />;
    }
    return (
      <>
        <button className="memory-back" onClick={() => navigate('/map')}>
          <Icon name="left" />
          返回地图
        </button>
        <Gallery
          view="map"
          albumId={albumId}
          location={{
            bounds,
            mapView: areaView ?? 'library',
            query: saved?.query ?? { ...emptyPhotoQuery },
          }}
          ownerId={ownerId}
          entryKey={entryKey}
          refresh={refresh}
          changed={changed}
        />
      </>
    );
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR PLACES</p>
          <h1>照片地图</h1>
          <p className="muted">在地图上重访去过的地方，按位置回看照片。</p>
        </div>
        <button
          disabled={!data?.extent || loading}
          onClick={() => data?.extent && setFit({ bounds: data.extent, nonce: Date.now() })}
        >
          <Icon name="map" />
          显示全部位置
        </button>
      </div>
      <section className="map-filters">
        <label className="field">
          位置范围
          <select
            value={state.mapView === 'album' ? 'album:' + state.albumId : state.mapView}
            onChange={(event) => {
              const value = event.target.value;
              setState({
                ...state,
                mapView: value.startsWith('album:') ? 'album' : (value as MapView),
                albumId: value.startsWith('album:') ? value.slice(6) : '',
              });
            }}
          >
            <option value="library">全部照片（含归档）</option>
            <option value="photos">照片</option>
            <option value="favorites">收藏</option>
            <option value="archive">归档</option>
            {albums.length > 0 && (
              <optgroup label="个人相册">
                {albums.map((album) => (
                  <option key={album.id} value={'album:' + album.id}>
                    {album.albumName}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <ErrorBox error={albumError} retry={() => setRetry((value) => value + 1)} />
      </section>
      <details
        className="map-search"
        open={filtersOpen}
        onToggle={(event) => setFiltersOpen(event.currentTarget.open)}
      >
        <summary>搜索、筛选与排序{hasPhotoFilters(state.query) ? '（已应用）' : ''}</summary>
        <PhotoFilters initialQuery={state.query} apply={(query) => setState({ ...state, query })} />
      </details>
      {state.mapView === 'photos' &&
        (state.query.q || state.query.tag || state.query.rating !== 'all') && (
          <p className="fine-print">
            照片范围的文件名、标签或评分筛选也包含已归档照片，与照片墙一致。
          </p>
        )}
      <ErrorBox error={error} retry={() => setRetry((value) => value + 1)} />
      <div className="map-status-row">
        <p role="status">
          {loading
            ? '正在查找位置…'
            : data
              ? `${data.total.toLocaleString()} 张照片有 GPS 信息 · 当前区域 ${data.visible.toLocaleString()} 张`
              : '等待地图加载'}
        </p>
        <button
          className="primary"
          disabled={loading || !!error || !data?.visible || !viewport}
          onClick={() => viewport && show(viewport.bounds)}
        >
          查看此区域的照片{!loading && data ? `（${data.visible}）` : ''}
        </button>
      </div>
      <p id="map-interaction-hint" className="fine-print">
        拖动地图查看其他区域，使用 + / −
        或双指缩放；点击位置标记可查看该位置的照片。地图聚合覆盖当前筛选的完整图库。
      </p>
      <div className="photo-map-frame">
        <MapCanvas
          position={state}
          clusters={data?.clusters ?? []}
          fit={fit}
          basemap={state.basemap}
          retry={tileRetry}
          moved={moved}
          select={(cluster) => {
            if (!error) setSelected(cluster);
          }}
          tileError={() => setTileError(true)}
        />
        {selected && !error && (
          <section className="map-place panel" aria-label="选中的位置">
            <button
              className="icon-button map-place-close"
              aria-label="关闭位置详情"
              onClick={() => setSelected(null)}
            >
              <Icon name="close" size={15} />
            </button>
            <div className="map-place-preview">
              <Preview id={selected.coverId} name="此位置的照片预览" />
            </div>
            <div className="map-place-copy">
              <strong>{selected.count.toLocaleString()} 张照片</strong>
              <p className="muted">
                纬度 {selected.latitude.toFixed(5)} · 经度 {selected.longitude.toFixed(5)}
              </p>
            </div>
            <button onClick={() => setFit({ bounds: selected.bounds, nonce: Date.now() })}>
              放大此位置
            </button>
            <button className="primary" onClick={() => show(selected.bounds)}>
              浏览此处照片
            </button>
          </section>
        )}
      </div>
      {tileError && state.basemap && (
        <div className="notice" role="status">
          <span>底图暂时无法加载，位置标记与照片仍可浏览。</span>
          <button
            onClick={() => {
              setTileError(false);
              setTileRetry((value) => value + 1);
            }}
          >
            重试底图
          </button>
        </div>
      )}
      <div className="map-provider">
        <label>
          <input
            type="checkbox"
            checked={state.basemap}
            onChange={(event) => {
              setState({ ...state, basemap: event.target.checked });
              setTileError(false);
            }}
          />
          显示底图
        </label>
        <p className="fine-print">
          底图由{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            OpenStreetMap
          </a>{' '}
          提供，会请求当前可见区域的地图瓦片；照片和原件仍从本站读取。
          <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer">
            报告地图问题
          </a>
          {' · '}
          <a href="/assets/leaflet-1.9.4-license.txt" target="_blank" rel="noreferrer">
            Leaflet 许可
          </a>
        </p>
      </div>
      {!loading && !error && data?.total === 0 && (
        <Empty icon="map" title="还没有符合条件的定位照片">
          可调整筛选，或在照片资料中读取原件信息、补填经纬度后再查看。
        </Empty>
      )}
    </>
  );
}
