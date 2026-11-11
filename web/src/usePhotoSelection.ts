import { useRef, useState } from 'react';
import { photoSelection, type SelectionAnchor } from './photo-selection';

export function usePhotoSelection(items: { id: string }[], report: (message: string) => void) {
  const [selected, save] = useState(new Set<string>());
  const current = useRef(selected),
    anchor = useRef<SelectionAnchor | null>(null);
  current.current = selected;
  function setSelected(next: Set<string>) {
    anchor.current = null;
    current.current = next;
    save(next);
  }
  function toggle(id: string, shift = false) {
    const result = photoSelection(
      items.map((photo) => photo.id),
      current.current,
      anchor.current,
      id,
      shift,
    );
    if (result.overflow) {
      report('所选照片：每次最多 1000 项，请先取消部分选择或缩小区间');
      return;
    }
    anchor.current = result.anchor;
    current.current = result.selected;
    save(result.selected);
  }
  return { selected, setSelected, toggle };
}
