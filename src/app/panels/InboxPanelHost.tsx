import { useRef, useState } from 'react';
import {
  beginPointerDragSession,
  dispatchPointerDragDrop,
  droppedPointerDrag,
  movePointerDragSession,
  type PointerDragSession,
} from '../dnd/pointer-drag.ts';
import {
  InboxPanel,
  type InboxDragHandlers,
  type InboxPanelProps,
} from '../../features/collect/InboxPanel.tsx';
import { inboxItemDragPayload, type InboxItem } from '../../features/collect/model.ts';
import styles from '../../features/collect/inbox.module.css';

interface ActiveDrag {
  readonly item: InboxItem;
  readonly session: PointerDragSession;
}

export type InboxPanelHostProps = Omit<InboxPanelProps, 'dragHandlers'>;

export function InboxPanelHost(props: InboxPanelHostProps) {
  const dragRef = useRef<ActiveDrag | null>(null);
  const [ghost, setGhost] = useState<{ readonly x: number; readonly y: number; readonly label: string } | null>(null);

  const clear = (): void => {
    dragRef.current = null;
    setGhost(null);
  };

  const dragHandlers: InboxDragHandlers = {
    onStart(item, event) {
      if (event.button !== 0) return;
      const session = beginPointerDragSession(
        inboxItemDragPayload(item),
        event.pointerId,
        { x: event.clientX, y: event.clientY },
      );
      dragRef.current = { item, session };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onMove(item, event) {
      const active = dragRef.current;
      if (active === null || active.item.id !== item.id) return;
      const session = movePointerDragSession(active.session, event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      if (session === null) return;
      dragRef.current = { item, session };
      if (session.phase === 'dragging') {
        setGhost({ x: event.clientX, y: event.clientY, label: item.kind === 'file' ? item.name : item.kind === 'link' ? item.label : item.text });
      }
    },
    onEnd(item, event) {
      const active = dragRef.current;
      if (active === null || active.item.id !== item.id) return;
      const payload = droppedPointerDrag(active.session, event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      clear();
      if (payload === null) return;
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (target?.closest('[data-canvas-drop-host], [data-editor-drop-host]') == null) return;
      dispatchPointerDragDrop({ payload, clientX: event.clientX, clientY: event.clientY });
    },
    onCancel(item, event) {
      if (dragRef.current?.item.id !== item.id) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      clear();
    },
  };

  return (
    <>
      <InboxPanel {...props} dragHandlers={dragHandlers} />
      {ghost !== null ? (
        <div className={styles.ghost} style={{ left: ghost.x + 12, top: ghost.y + 12 }}>
          {ghost.label}
        </div>
      ) : null}
    </>
  );
}
