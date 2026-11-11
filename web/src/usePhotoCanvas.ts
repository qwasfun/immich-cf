import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';
import {
  boundedView,
  fittedImage,
  fitView,
  zoomView,
  type Point,
  type Size,
  type View,
} from './viewer-geometry';

export function usePhotoCanvas(
  id: string,
  pause: () => void,
  previous?: () => void,
  next?: () => void,
  enabled = true,
) {
  const root = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [image, setImage] = useState({ id: '', width: 0, height: 0, status: 'loading' });
  const [stored, setStored] = useState({ id, ...fitView() });
  const view = stored.id === id ? stored : fitView(),
    ready = enabled && image.id === id && image.status === 'ready';
  const dimensions = image.id === id ? image : { width: 0, height: 0 };
  const current = useRef({ view, viewport, image: dimensions, ready, pause, previous, next, id });
  current.current = { view, viewport, image: dimensions, ready, pause, previous, next, id };
  const points = useRef(new Map<number, Point>());
  const gesture = useRef<{
    start: Point;
    view: View;
    distance: number;
    pinched: boolean;
    touch: boolean;
  } | null>(null);
  const lastTap = useRef<{ time: number; point: Point } | null>(null),
    lastTouch = useRef(0);
  function update(candidate: View) {
    const state = current.current,
      bounded = boundedView(candidate, state.viewport, state.image);
    current.current.view = bounded;
    setStored({ id: state.id, ...bounded });
  }
  function reset() {
    update(fitView());
    points.current.clear();
    gesture.current = null;
    lastTap.current = null;
  }
  function zoom(scale: number, point: Point = { x: 0, y: 0 }) {
    if (!current.current.ready) return;
    const state = current.current;
    state.pause();
    update(zoomView(state.view, scale, point, state.viewport, state.image));
  }
  function point(clientX: number, clientY: number): Point {
    const rect = root.current!.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  }
  const midpoint = (values: Point[]) =>
    values.length > 1
      ? { x: (values[0]!.x + values[1]!.x) / 2, y: (values[0]!.y + values[1]!.y) / 2 }
      : values[0]!;
  const distance = (values: Point[]) =>
    values.length > 1 ? Math.hypot(values[0]!.x - values[1]!.x, values[0]!.y - values[1]!.y) : 0;
  function begin(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      !ready ||
      event.button !== 0 ||
      (event.target as HTMLElement).closest('button,a,input,select')
    )
      return;
    pause();
    if (event.pointerType === 'touch') lastTouch.current = Date.now();
    points.current.set(event.pointerId, point(event.clientX, event.clientY));
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* Pointer may already have ended. */
    }
    const values = [...points.current.values()];
    gesture.current = {
      start: midpoint(values),
      distance: distance(values),
      view: current.current.view,
      pinched: values.length > 1,
      touch: event.pointerType === 'touch',
    };
    if (values.length > 1) lastTap.current = null;
  }
  function move(event: ReactPointerEvent<HTMLDivElement>) {
    if (!points.current.has(event.pointerId) || !gesture.current) return;
    points.current.set(event.pointerId, point(event.clientX, event.clientY));
    const values = [...points.current.values()],
      center = midpoint(values),
      start = gesture.current;
    if (values.length > 1 && start.distance > 0) {
      const scale = Math.min(
          4,
          Math.max(1, (start.view.scale * distance(values)) / start.distance),
        ),
        factor = scale / start.view.scale;
      update({
        scale,
        x: center.x - (start.start.x - start.view.x) * factor,
        y: center.y - (start.start.y - start.view.y) * factor,
      });
    } else if (start.view.scale > 1)
      update({
        ...start.view,
        x: start.view.x + center.x - start.start.x,
        y: start.view.y + center.y - start.start.y,
      });
  }
  function end(event: ReactPointerEvent<HTMLDivElement>, cancel = false) {
    if (!points.current.has(event.pointerId)) return;
    const start = gesture.current,
      finish = point(event.clientX, event.clientY);
    points.current.delete(event.pointerId);
    if (!cancel && start && start.touch && !start.pinched && points.current.size === 0) {
      const dx = finish.x - start.start.x,
        dy = finish.y - start.start.y;
      if (start.view.scale === 1 && Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        lastTap.current = null;
        if (dx > 0) current.current.previous?.();
        else current.current.next?.();
      } else if (Math.hypot(dx, dy) < 8) {
        const tap = lastTap.current,
          now = Date.now();
        if (
          tap &&
          now - tap.time < 300 &&
          Math.hypot(tap.point.x - finish.x, tap.point.y - finish.y) < 30
        ) {
          lastTap.current = null;
          if (current.current.view.scale > 1) reset();
          else zoom(2, finish);
        } else lastTap.current = { time: now, point: finish };
      }
    }
    if (points.current.size) {
      const values = [...points.current.values()];
      gesture.current = {
        start: midpoint(values),
        distance: distance(values),
        view: current.current.view,
        pinched: true,
        touch: !!start?.touch,
      };
    } else gesture.current = null;
    if (cancel) lastTap.current = null;
  }
  function doubleClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (
      Date.now() - lastTouch.current < 500 ||
      !ready ||
      (event.target as HTMLElement).closest('button,a')
    )
      return;
    event.preventDefault();
    pause();
    if (current.current.view.scale > 1) reset();
    else zoom(2, point(event.clientX, event.clientY));
  }
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const resize = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled]);
  useLayoutEffect(() => {
    update(current.current.view);
  }, [viewport.width, viewport.height, image.width, image.height]);
  useEffect(() => {
    points.current.clear();
    gesture.current = null;
    lastTap.current = null;
  }, [id]);
  useEffect(() => {
    if (!enabled) {
      reset();
      setImage({ id: '', width: 0, height: 0, status: 'loading' });
    }
  }, [enabled]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!current.current.ready || !event.deltaY) return;
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? current.current.viewport.height : 1);
      zoom(
        current.current.view.scale * Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.002),
        point(event.clientX, event.clientY),
      );
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [enabled]);
  function loaded(width: number, height: number) {
    setImage({ id, width, height, status: 'ready' });
  }
  function failed() {
    setImage({ id, width: 0, height: 0, status: 'error' });
    pause();
  }
  return {
    root,
    view,
    ready,
    failed: image.id === id && image.status === 'error',
    fitted: fittedImage(viewport, dimensions),
    loaded,
    onError: failed,
    zoom,
    reset,
    pan: (x: number, y: number) => {
      pause();
      update({
        ...current.current.view,
        x: current.current.view.x + x,
        y: current.current.view.y + y,
      });
    },
    handlers: {
      onPointerDown: begin,
      onPointerMove: move,
      onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => end(e),
      onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => end(e, true),
      onLostPointerCapture: (e: ReactPointerEvent<HTMLDivElement>) => end(e, true),
      onDoubleClick: doubleClick,
    },
  };
}
