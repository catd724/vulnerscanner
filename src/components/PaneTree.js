'use client';

import { useRef, useCallback } from 'react';
import TerminalPane from './TerminalPane';
import { useStore } from '@/lib/store';

/**
 * terminal.ai - split view renderer.
 *
 * Walks a tab's binary layout tree. 'row' places panes side by side with a
 * vertical divider, 'col' stacks them. Dividers are draggable; the ratio lives
 * in the store so a layout survives tab switches.
 */

function Divider({ dir, containerRef, onRatio }) {
  const dragging = useRef(false);

  const onPointerDown = useCallback(
    (event) => {
      event.preventDefault();
      dragging.current = true;
      const container = containerRef.current;
      if (!container) return;

      const move = (e) => {
        if (!dragging.current) return;
        const rect = container.getBoundingClientRect();
        const ratio =
          dir === 'row'
            ? (e.clientX - rect.left) / rect.width
            : (e.clientY - rect.top) / rect.height;
        // Clamp so a pane can never be dragged to zero and become unrecoverable.
        onRatio(Math.min(0.9, Math.max(0.1, ratio)));
      };

      const up = () => {
        dragging.current = false;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.body.classList.remove('is-resizing');
      };

      document.body.classList.add('is-resizing');
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [dir, containerRef, onRatio]
  );

  return (
    <div
      className={`split-divider split-divider-${dir}`}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation={dir === 'row' ? 'vertical' : 'horizontal'}
    />
  );
}

export default function PaneTree({ tab, node, hostsById }) {
  const containerRef = useRef(null);
  const setPaneRatio = useStore((s) => s.setPaneRatio);
  const setActivePane = useStore((s) => s.setActivePane);

  if (!node) return null;

  if (node.type === 'leaf') {
    const pane = tab.panes[node.paneId];
    if (!pane) return null;
    return (
      <TerminalPane
        tabId={tab.id}
        pane={pane}
        host={hostsById[pane.hostId]}
        isActive={tab.activePaneId === pane.paneId}
        onFocus={() => setActivePane(tab.id, pane.paneId)}
      />
    );
  }

  const ratio = node.ratio ?? 0.5;

  return (
    <div ref={containerRef} className={`split split-${node.dir}`}>
      <div className="split-child" style={{ flex: `${ratio} 1 0%` }}>
        <PaneTree tab={tab} node={node.a} hostsById={hostsById} />
      </div>
      <Divider
        dir={node.dir}
        containerRef={containerRef}
        onRatio={(value) => setPaneRatio(tab.id, node.nodeId, value)}
      />
      <div className="split-child" style={{ flex: `${1 - ratio} 1 0%` }}>
        <PaneTree tab={tab} node={node.b} hostsById={hostsById} />
      </div>
    </div>
  );
}
