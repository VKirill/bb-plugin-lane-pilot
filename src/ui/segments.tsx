import { Button } from "@lane-pilot/ui-kit";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import { CONTROL_H } from "@lane-pilot/ui-kit";

/**
 * 2 to 5 slices of one set (DESIGN.md): a segment control on a wide column, one select on a phone.
 * `testId` names the control; each segment is `seg-<testId>-<id>`.
 */
export function Segments({ testId, label, items, value, onChange, compact, badge }: {
  testId: string;
  label: string;
  items: Array<{ id: string; label: string }>;
  value: string;
  onChange: (next: string) => void;
  compact: boolean;
  badge?: Record<string, string | number | null | undefined>;
}) {
  const text = (item: { id: string; label: string }) => (badge?.[item.id] != null && badge[item.id] !== 0 ? `${item.label} ${badge[item.id]}` : item.label);
  if (compact) {
    return (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label} data-testid={`seg-select-${testId}`} className={`${CONTROL_H} w-full min-w-0`}><SelectValue /></SelectTrigger>
        <SelectContent>{items.map((item) => <SelectItem key={item.id} value={item.id}>{text(item)}</SelectItem>)}</SelectContent>
      </Select>
    );
  }
  return (
    <div className="lp-seg max-w-full flex-wrap" role="group" aria-label={label} data-testid={`seg-${testId}`}>
      {items.map((item) => (
        <Button key={item.id} variant="ghost" data-testid={`seg-${testId}-${item.id}`}
          className="lp-seg-item h-[1.875rem] px-3 hover:bg-transparent aria-pressed:bg-[var(--lp-card)] aria-pressed:hover:bg-[var(--lp-card)]"
          aria-pressed={value === item.id} onClick={() => onChange(item.id)}>{text(item)}</Button>
      ))}
    </div>
  );
}
