"use client";

import * as React from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Copy,
  GripVertical,
  MoreVertical,
  Trash2,
} from "lucide-react";
import type { Panel } from "@/lib/ir";
import { canMove, type PanelMove } from "@/lib/panel-list";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";

/**
 * The editor's panel list: select, reorder, duplicate and delete.
 *
 * Every action exists twice on purpose — in the overflow menu, where it has a
 * name a screen reader reads and a keyboard reaches, and on the drag handle
 * for the pointer. The list used to be a `<button>` per panel with a bare
 * `Trash2` icon inside it and a click handler on the icon: nested controls,
 * no accessible name, and no way to change the order at all.
 *
 * Reordering moves the panel through the `panels` array and touches no
 * `layout`, so a hand-positioned grid survives it — see `src/lib/panel-list.ts`.
 */
export function PanelList({
  panels,
  selectedId,
  onSelect,
  onMove,
  onReorder,
  onDuplicate,
  onDelete,
}: {
  panels: Panel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, move: PanelMove) => void;
  /** Commit a drop: put `id` at index `to`. */
  onReorder: (id: string, to: number) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  // The panel under the pointer during a drag, and the row it is over. Held
  // in state rather than on the event so the drop target can be shown.
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [over, setOver] = React.useState<string | null>(null);

  function endDrag() {
    setDragging(null);
    setOver(null);
  }

  function drop(targetId: string) {
    const to = panels.findIndex((p) => p.id === targetId);
    if (dragging && to >= 0 && dragging !== targetId) onReorder(dragging, to);
    endDrag();
  }

  return (
    <ul className="space-y-1">
      {panels.map((p, i) => (
        <li
          key={p.id}
          onDragOver={(e) => {
            if (!dragging) return;
            // Without this the drop is refused by the browser.
            e.preventDefault();
            setOver(p.id);
          }}
          onDrop={(e) => {
            e.preventDefault();
            drop(p.id);
          }}
          className={`flex items-center gap-1 pr-1 ${
            p.id === selectedId ? "bg-surface-2" : "hover:bg-surface-2"
          } ${over === p.id && dragging !== p.id ? "outline-2 outline-primary" : ""} ${
            dragging === p.id ? "opacity-50" : ""
          }`}
        >
          <span
            draggable
            onDragStart={(e) => {
              setDragging(p.id);
              e.dataTransfer.effectAllowed = "move";
              // Firefox starts no drag at all without payload on the event.
              e.dataTransfer.setData("text/plain", p.id);
            }}
            onDragEnd={endDrag}
            aria-hidden="true"
            className="shrink-0 cursor-grab px-1 py-1.5 text-muted active:cursor-grabbing"
          >
            <GripVertical className="h-4 w-4" />
          </span>
          <button
            type="button"
            onClick={() => onSelect(p.id)}
            aria-current={p.id === selectedId ? "true" : undefined}
            className="min-w-0 flex-1 px-1 py-1.5 text-left text-sm"
          >
            <span className="block truncate">{p.title}</span>
            <span className="sr-only">
              Panel {i + 1} of {panels.length}
            </span>
          </button>
          <Menu
            label={`Actions for ${p.title}`}
            trigger={<MoreVertical className="h-4 w-4" />}
          >
            <MenuItem onClick={() => onDuplicate(p.id)}>
              <Copy className="h-4 w-4" /> Duplicate
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              onClick={() => onMove(p.id, "up")}
              disabled={!canMove(panels, p.id, "up")}
            >
              <ArrowUp className="h-4 w-4" /> Move up
            </MenuItem>
            <MenuItem
              onClick={() => onMove(p.id, "down")}
              disabled={!canMove(panels, p.id, "down")}
            >
              <ArrowDown className="h-4 w-4" /> Move down
            </MenuItem>
            <MenuItem
              onClick={() => onMove(p.id, "top")}
              disabled={!canMove(panels, p.id, "top")}
            >
              <ArrowUpToLine className="h-4 w-4" /> Move to top
            </MenuItem>
            <MenuItem
              onClick={() => onMove(p.id, "bottom")}
              disabled={!canMove(panels, p.id, "bottom")}
            >
              <ArrowDownToLine className="h-4 w-4" /> Move to bottom
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger onClick={() => onDelete(p.id)}>
              <Trash2 className="h-4 w-4" /> Delete
            </MenuItem>
          </Menu>
        </li>
      ))}
    </ul>
  );
}
