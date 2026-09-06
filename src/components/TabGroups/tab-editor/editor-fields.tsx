import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@src/lib/utils";

type SectionHeadingProps = {
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
};

export function SectionHeading({ icon, label, trailing }: SectionHeadingProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3
        className={cn(
          "flex items-center gap-2 text-sm font-semibold text-foreground-neutral",
          "tracking-[-0.005em]",
        )}
        style={{ textWrap: "balance" }}
      >
        <span className="text-foreground-tertiary">{icon}</span>
        {label}
      </h3>
      {trailing}
    </div>
  );
}

type EditorFieldProps = {
  label: string;
  children: ReactNode;
  error?: string | null;
};

export function EditorField({ label, children, error }: EditorFieldProps) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-foreground-secondary">
        {label}
      </label>
      {children}
      {error ? (
        <p className="flex items-center gap-1.5 text-xs text-foreground-danger">
          <AlertCircle size={12} className="flex-shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

type MetadataItemProps = {
  icon: ReactNode;
  label: string;
  value: string;
  mono?: boolean;
};

export function MetadataItem({
  icon,
  label,
  value,
  mono = false,
}: MetadataItemProps) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-[11px] font-medium text-foreground-tertiary uppercase tracking-wider">
        <span className="text-foreground-tertiary/70">{icon}</span>
        {label}
      </dt>
      <dd
        className={cn(
          "mt-0.5 text-sm text-foreground-secondary truncate tabular-nums",
          mono && "font-mono text-xs",
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}
