export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface View extends Point {
  scale: number;
}
export const fitView = (): View => ({ scale: 1, x: 0, y: 0 });
export function fittedImage(viewport: Size, image: Size): Size {
  if (viewport.width <= 0 || viewport.height <= 0 || image.width <= 0 || image.height <= 0)
    return { width: 0, height: 0 };
  const ratio = Math.min(viewport.width / image.width, viewport.height / image.height);
  return { width: image.width * ratio, height: image.height * ratio };
}
export function boundedView(view: View, viewport: Size, image: Size): View {
  const scale = Math.min(4, Math.max(1, view.scale)),
    fitted = fittedImage(viewport, image);
  const maxX = Math.max(0, (fitted.width * scale - viewport.width) / 2),
    maxY = Math.max(0, (fitted.height * scale - viewport.height) / 2);
  return {
    scale,
    x: maxX ? Math.min(maxX, Math.max(-maxX, view.x)) : 0,
    y: maxY ? Math.min(maxY, Math.max(-maxY, view.y)) : 0,
  };
}
export function zoomView(
  view: View,
  scale: number,
  point: Point,
  viewport: Size,
  image: Size,
): View {
  const next = Math.min(4, Math.max(1, scale)),
    factor = next / view.scale;
  return boundedView(
    {
      scale: next,
      x: point.x - (point.x - view.x) * factor,
      y: point.y - (point.y - view.y) * factor,
    },
    viewport,
    image,
  );
}
