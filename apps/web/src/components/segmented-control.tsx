import { SelectorRow } from "@knowledge-base/ui/components/selector-row";
import { ToggleGroup, ToggleGroupItem } from "@knowledge-base/ui/components/toggle-group";

type SegmentedControlProps<T extends string> = {
  value: T;
  onChange: (next: T) => void;
  items: { value: T; label: string }[];
  ariaLabel?: string;
  className?: string;
};

export function SegmentedControl<T extends string>({
  value,
  onChange,
  items,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  const isItemValue = (candidate: string): candidate is T =>
    items.some((item) => item.value === candidate);

  return (
    <SelectorRow className={className}>
      <ToggleGroup
        value={[value]}
        onValueChange={(next) => {
          const selected = next.find(isItemValue);
          if (selected) onChange(selected);
        }}
        spacing={1}
        aria-label={ariaLabel}
        className="inline-flex w-max gap-1 rounded-md border p-1"
      >
        {items.map((item) => (
          <ToggleGroupItem
            key={item.value}
            value={item.value}
            size="sm"
            className="min-h-[44px] shrink-0 rounded-sm aria-pressed:bg-secondary aria-pressed:text-secondary-foreground"
          >
            {item.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </SelectorRow>
  );
}
