import React from "react";
import { cn } from "@src/lib/utils";

interface SidePanelProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

const SidePanel = React.forwardRef<HTMLDivElement, SidePanelProps>(
  ({ children, className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "h-full w-[240px] bg-background-page-secondary shadow-lg transition-transform duration-300 ease-in-out overflow-hidden",
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);

SidePanel.displayName = "SidePanel";

export default SidePanel;
