import { Check, Loader2, Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';

export interface PolicyResourceOption {
  id: string;
  name: string;
  description?: string;
  sourceLabel?: string;
  unavailable?: boolean;
}

interface PolicyResourcePickerProps {
  label: string;
  options: PolicyResourceOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  emptyText: string;
}

export function PolicyResourcePicker({
  label,
  options,
  selectedIds,
  onChange,
  loading,
  error,
  disabled,
  emptyText,
}: PolicyResourcePickerProps) {
  const searchId = useId();
  const [query, setQuery] = useState('');
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter(
      (option) =>
        option.name.toLowerCase().includes(normalized) ||
        option.id.toLowerCase().includes(normalized) ||
        option.description?.toLowerCase().includes(normalized),
    );
  }, [options, query]);

  const toggle = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };

  return (
    <div className={disabled ? 'opacity-60' : undefined}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label
          htmlFor={searchId}
          className="text-xs font-medium text-muted-foreground"
        >
          {label}
        </label>
        {!loading && !error && selectedIds.length > 0 && (
          <span
            aria-live="polite"
            className="inline-flex items-center gap-1 text-[11px] text-primary"
          >
            <Check className="h-3 w-3" />
            已选 {selectedIds.length}
          </span>
        )}
      </div>
      <div className="overflow-hidden rounded-md border bg-background">
        <div className="relative border-b">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            id={searchId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称或 ID"
            disabled={disabled || loading}
            aria-label={`搜索${label}`}
            className="h-10 rounded-none border-0 pl-8 shadow-none focus-visible:ring-2 focus-visible:ring-inset"
          />
        </div>
        <div className="max-h-[min(48vh,28rem)] overflow-y-auto p-1.5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在加载目录
            </div>
          ) : error ? (
            <div className="px-2 py-5 text-center text-xs text-error">
              {error}
            </div>
          ) : visible.length === 0 ? (
            <div className="px-2 py-5 text-center text-xs text-muted-foreground">
              {query ? '没有匹配项' : emptyText}
            </div>
          ) : (
            visible.map((option) => (
              <label
                key={option.id}
                className={`flex items-start gap-2 rounded px-2 py-2 text-left transition-colors ${
                  disabled
                    ? 'cursor-not-allowed'
                    : 'cursor-pointer hover:bg-muted/60'
                }`}
              >
                <Checkbox
                  checked={selected.has(option.id)}
                  onCheckedChange={() => toggle(option.id)}
                  disabled={disabled}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-foreground">
                    <span className="truncate">{option.name}</span>
                    {option.sourceLabel && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                        {option.sourceLabel}
                      </span>
                    )}
                    {option.unavailable && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                        当前不可用
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                    {option.id}
                  </span>
                  {option.description && (
                    <span className="mt-0.5 block line-clamp-2 text-[11px] text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </span>
              </label>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
