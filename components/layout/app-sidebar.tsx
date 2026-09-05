"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { 
  LayoutDashboard, 
  FileText, 
  MessageSquare, 
  ShoppingCart, 
  CreditCard,
  MessageCircleQuestion,
  CheckSquare
} from "lucide-react";
import { cn } from "@/lib/utils";

const buyerNavItems = [
  { href: "/buyer", label: "Overview", icon: LayoutDashboard },
  { href: "/buyer/rfqs", label: "RFQs", icon: FileText },
  { href: "/buyer/quotes", label: "Quotes", icon: MessageSquare },
  { href: "/buyer/orders", label: "Orders", icon: ShoppingCart },
  { href: "/buyer/payments", label: "Payments", icon: CreditCard },
  { href: "/buyer/assistant", label: "AI Assistant", icon: MessageCircleQuestion },
];

export function AppSidebar() {
  const pathname = usePathname();
  const isBuyer = pathname.startsWith("/buyer");
  
  const navItems = isBuyer ? buyerNavItems : [
    { href: "/merchant", label: "Approvals", icon: CheckSquare },
  ];

  return (
    <aside className="fixed inset-y-0 left-0 z-10 hidden w-64 flex-col border-r border-border bg-card sm:flex">
      <div className="flex h-14 items-center border-b border-border px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <div className="size-6 rounded-md bg-primary flex items-center justify-center">
            <span className="text-primary-foreground text-sm font-bold">P</span>
          </div>
          <span>ProcureERP</span>
        </Link>
      </div>
      <nav className="flex-1 overflow-y-auto py-4">
        <ul className="grid gap-1 px-2">
          {navItems.map((item) => {
            // Precise match for dashboard to avoid highlighting everything
            const isActive = item.href === "/buyer" || item.href === "/merchant" 
              ? pathname === item.href 
              : pathname.startsWith(item.href);
              
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="border-t border-border p-4">
        <div className="text-xs text-muted-foreground">
          ERP Frontend Redesign
        </div>
      </div>
    </aside>
  );
}
