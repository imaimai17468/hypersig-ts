/** @jsxImportSource react */
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  Announcements,
  DragEndEvent,
  UniqueIdentifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";
import type { AttributeValues, Emit } from "../../src/element.js";
import { reactElement } from "../../src/react.js";
import { sortableList } from "./elements.js";
import type { Item } from "./elements.js";

type Props = Partial<AttributeValues<typeof sortableList>> & {
  emit: Emit<typeof sortableList>;
};

/** An order the user dropped, and the attribute values it was dropped on. */
interface PendingOrder {
  order: Item[];
  itemsText: string;
  failures: number | undefined;
}

/** The order after dropping `active` on `over`, or null when nothing moves. */
function dropOrder(
  base: readonly Item[],
  active: UniqueIdentifier,
  over: UniqueIdentifier
): Item[] | null {
  const from = base.findIndex((item) => item.key === active);
  const to = base.findIndex((item) => item.key === over);
  if (from === -1 || to === -1 || from === to) return null;
  return arrayMove([...base], from, to);
}

/**
 * Shows the server's order from `items`. A drop shows the new order as
 * pending and emits it; the pending order is dropped when `items` (the
 * committed order) or `failures` (a failed save) changes. While a row is
 * dragged, the rows stay in the order the drag started from, and the drop
 * applies to the latest `items`.
 */
function SortableList({ items = [], failures, emit }: Props) {
  const [pending, setPending] = useState<PendingOrder | null>(null);
  const [dragOrder, setDragOrder] = useState<Item[] | null>(null);
  const itemsText = JSON.stringify(items);
  const isPendingCurrent =
    pending !== null &&
    pending.itemsText === itemsText &&
    pending.failures === failures;
  // Forget an outdated order so that it cannot come back with an old value.
  if (pending !== null && !isPendingCurrent) setPending(null);
  const latest = isPendingCurrent ? pending.order : items;
  const shown = dragOrder ?? latest;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const labelOf = (key: UniqueIdentifier) =>
    items.find((item) => item.key === key)?.label ?? String(key);
  const positionOf = (key: UniqueIdentifier) =>
    shown.findIndex((item) => item.key === key) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up ${labelOf(active.id)}, position ${positionOf(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${labelOf(active.id)} is over position ${positionOf(over.id)}.`
        : `${labelOf(active.id)} is not over the list.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `Dropped ${labelOf(active.id)} at position ${positionOf(over.id)}.`
        : `Dropped ${labelOf(active.id)}.`,
    onDragCancel: ({ active }) =>
      `Put ${labelOf(active.id)} back at position ${positionOf(active.id)}.`,
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragOrder(null);
    if (!over) return;
    const order = dropOrder(latest, active.id, over.id);
    if (!order) return;
    setPending({ order, itemsText, failures });
    const keys = order.map((item) => item.key);
    emit("reorder", keys);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={{ announcements }}
      onDragStart={() => setDragOrder(shown)}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragOrder(null)}
    >
      <SortableContext
        items={shown.map((item) => item.key)}
        strategy={verticalListSortingStrategy}
      >
        <ol aria-label="Tasks" aria-busy={isPendingCurrent || undefined}>
          {shown.map((item) => (
            <Row key={item.key} item={item} />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function Row({ item }: { item: Item }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.key });
  return (
    <li
      ref={setNodeRef}
      // React writes these through `element.style`, which CSP allows.
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-dragging={isDragging || undefined}
    >
      <button
        type="button"
        className="handle"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Move ${item.label}`}
      />
      <span>{item.label}</span>
    </li>
  );
}

reactElement(sortableList, SortableList);
