import { Streamdown } from "streamdown";

export function MessageResponse({ children }: { children: string }) {
  return (
    <Streamdown className="ai-message-response" mode="streaming">
      {children}
    </Streamdown>
  );
}
