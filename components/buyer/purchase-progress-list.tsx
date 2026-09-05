import { AlertCircle, CheckCircle2, Circle, Loader2 } from "lucide-react";
import type { PurchaseStage, PurchaseStageState } from "@/lib/ui/purchase-progress";
import { cn } from "@/lib/utils";

/**
 * Renders the five-item Request/Quote/Approval/Order/Payment checklist
 * produced by lib/ui/purchase-progress.ts as a compact horizontal stepper.
 */
const STATE_STYLES: Record<PurchaseStageState, { icon: typeof Circle; className: string; lineClassName: string }> = {
  done: { icon: CheckCircle2, className: "text-emerald-600 dark:text-emerald-400", lineClassName: "bg-emerald-600 dark:bg-emerald-400" },
  active: { icon: Loader2, className: "text-primary", lineClassName: "bg-primary" },
  upcoming: { icon: Circle, className: "text-muted-foreground/40", lineClassName: "bg-muted-foreground/20" },
  blocked: { icon: AlertCircle, className: "text-destructive", lineClassName: "bg-destructive/40" },
};

export function PurchaseProgressList({ stages }: { stages: PurchaseStage[] }) {
  return (
    <div className="flex w-full items-center justify-between py-2 overflow-x-auto pb-4">
      {stages.map((stage, index) => {
        const { icon: Icon, className, lineClassName } = STATE_STYLES[stage.state];
        const isLast = index === stages.length - 1;
        
        return (
          <div key={stage.key} className={cn("flex flex-col relative", isLast ? "flex-none" : "flex-1")}>
            <div className="flex items-center">
              <div className="relative flex items-center justify-center">
                <Icon
                  aria-hidden
                  className={cn("size-6 shrink-0 bg-background z-10", className, stage.state === "active" ? "animate-spin" : "")}
                />
              </div>
              {!isLast && (
                <div className={cn("h-0.5 w-full flex-1 mx-2", lineClassName)} />
              )}
            </div>
            
            <div className="mt-2 flex flex-col pr-4">
              <span
                className={cn(
                  "text-xs font-semibold whitespace-nowrap",
                  stage.state === "upcoming" ? "text-muted-foreground" : "text-foreground"
                )}
              >
                {stage.label}
              </span>
              <span className="text-[10px] text-muted-foreground leading-tight mt-0.5 line-clamp-2 max-w-[100px]" title={stage.detail}>
                {stage.detail}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
