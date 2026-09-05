"use client";

import { AgentPanel } from "@/components/buyer/agent-panel";

export default function AssistantPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold tracking-tight">AI Purchasing Assistant</h2>
        <p className="text-muted-foreground">
          Ask our AI assistant to help you with your procurement needs. It will check rules, get quotes, and guide you through the process.
        </p>
      </div>
      
      <div className="mt-2">
        <AgentPanel />
      </div>
    </div>
  );
}
